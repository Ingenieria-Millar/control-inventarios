// Tests de integración contra la app Express en modo JSON (sin PostgreSQL).
// Cubren: autenticación, rate-limit/lockout, política de contraseña, validación de rol,
// aislamiento multiempresa, ventas/stock, auditoría (D1) y vigencia del plan (D2).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Forzar modo JSON con archivo temporal y credenciales semilla fijas — antes de cargar el módulo.
const DB_PATH = path.join(__dirname, '..', 'data', 'test-api.json');
process.env.DB_PATH = DB_PATH;
process.env.SEED_SUPER_PASS = 'SuperClave123';
process.env.SEED_DEMO_PASS = 'DemoClave123';
delete process.env.DATABASE_URL;
delete process.env.NODE_ENV;

const srv = require('../server.js');

let server, base, root;
let superToken, demoToken;

async function api(method, p, { token, body } = {}){
  const headers = { 'Content-Type':'application/json' };
  if(token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch(e){}
  return { status: res.status, json };
}
const login = (empresa, username, password) => api('POST', '/auth/login', { body:{ empresa, username, password } });

before(async () => {
  try { fs.rmSync(DB_PATH, { force:true }); } catch(e){}
  await srv.init();
  await new Promise(r => { server = srv.app.listen(0, () => r()); });
  const port = server.address().port;
  base = `http://127.0.0.1:${port}/api`;
  root = `http://127.0.0.1:${port}`;
  superToken = (await login('Nexo', 'Soporte', 'SuperClave123')).json.token;
  demoToken  = (await login('JEROTECH', 'DEMO', 'DemoClave123')).json.token;
});

after(() => { if(server) server.close(); });

test('health responde ok', async () => {
  const r = await api('GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
});

test('sirve el frontend (HTML) en la raíz', async () => {
  const res = await fetch(root + '/');
  const body = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(body.startsWith('<!DOCTYPE'), 'debe servir el index.html');
});

test('login válido devuelve token y usuario', async () => {
  assert.ok(superToken && superToken.length >= 40);
  const r = await login('JEROTECH', 'DEMO', 'DemoClave123');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.role, 'admin');
});

test('login con contraseña incorrecta -> 401 CREDENCIALES', async () => {
  const r = await login('JEROTECH', 'DEMO', 'noEsLaClave');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'CREDENCIALES');
});

test('empresa inexistente -> 401 genérico (anti-enumeración)', async () => {
  const r = await login('NO_EXISTE_SA', 'x', 'yyyyyyyy');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'CREDENCIALES');
});

test('ruta protegida sin token -> 401', async () => {
  const r = await api('GET', '/products');
  assert.strictEqual(r.status, 401);
});

test('lockout: 5 fallos seguidos por cuenta -> 6º intento 429', async () => {
  const u = 'cuentaCebo'; // cuenta única para no bloquear DEMO
  for(let i=0;i<5;i++){
    const r = await login('JEROTECH', u, 'malaClave');
    assert.strictEqual(r.status, 401);
  }
  const sexto = await login('JEROTECH', u, 'malaClave');
  assert.strictEqual(sexto.status, 429);
  assert.strictEqual(sexto.json.error.code, 'BLOQUEO_TEMPORAL');
});

test('política de contraseña: <8 caracteres -> 400', async () => {
  const r = await api('POST', '/users', { token:superToken, body:{ username:'corto', password:'123', role:'tienda', tenant_id:1 } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'VALIDACION');
});

test('validación de rol: rol inválido en PATCH /users -> 400', async () => {
  const r = await api('PATCH', '/users/2', { token:superToken, body:{ role:'hacker', confirm_password:'SuperClave123' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'ROL_INVALIDO');
});

test('aislamiento multiempresa: una empresa no ve productos de otra', async () => {
  await api('POST', '/tenants', { token:superToken, body:{ name:'TENANT_A' } });
  await api('POST', '/tenants', { token:superToken, body:{ name:'TENANT_B' } });
  const list = (await api('GET', '/tenants', { token:superToken })).json;
  const A = list.find(t=>t.name==='TENANT_A'), B = list.find(t=>t.name==='TENANT_B');
  await api('POST', '/users', { token:superToken, body:{ username:'admA', password:'claveA123', role:'admin', tenant_id:A.id } });
  await api('POST', '/users', { token:superToken, body:{ username:'admB', password:'claveB123', role:'admin', tenant_id:B.id } });
  const tokA = (await login('TENANT_A', 'admA', 'claveA123')).json.token;
  const tokB = (await login('TENANT_B', 'admB', 'claveB123')).json.token;
  const pA = (await api('POST', '/products', { token:tokA, body:{ name:'Producto-A', price:1000, cost:500, stock:5 } })).json;
  await api('POST', '/products', { token:tokB, body:{ name:'Producto-B', price:2000, cost:900, stock:5 } });

  const listadoA = (await api('GET', '/products', { token:tokA })).json;
  const listadoB = (await api('GET', '/products', { token:tokB })).json;
  assert.ok(listadoA.every(p=>p.name!=='Producto-B'), 'A no debe ver productos de B');
  assert.ok(listadoB.every(p=>p.name!=='Producto-A'), 'B no debe ver productos de A');
  // B no puede leer el producto de A por id directo
  const cross = await api('PUT', `/products/${pA.id}`, { token:tokB, body:{ name:'hack' } });
  assert.strictEqual(cross.status, 404, 'cross-tenant por id debe ser 404');
});

test('venta descuenta stock y calcula IVA 19%; stock insuficiente -> 409', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ParaVender', price:11900, cost:5000, stock:5 } })).json;
  const venta = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:2 }], pay_method:'efectivo' } });
  assert.strictEqual(venta.status, 201);
  assert.strictEqual(venta.json.total, 23800);
  assert.strictEqual(venta.json.subtotal + venta.json.iva, venta.json.total); // base + IVA = total
  const prods = (await api('GET', '/products', { token:demoToken })).json;
  assert.strictEqual(prods.find(x=>x.id===p.id).stock, 3, 'stock 5 - 2 = 3');
  const sobreventa = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:999 }] } });
  assert.strictEqual(sobreventa.status, 409);
  assert.strictEqual(sobreventa.json.error.code, 'STOCK_INSUFICIENTE');
});

test('auditoría (D1): login y ajuste de stock quedan registrados', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ParaAjuste', price:1000, cost:400, stock:10 } })).json;
  await api('POST', '/adjustments', { token:demoToken, body:{ product_id:p.id, type:'salida', qty:1, motivo:'test' } });
  const audit = (await api('GET', '/company/audit', { token:demoToken })).json;
  assert.ok(Array.isArray(audit));
  assert.ok(audit.some(e=>e.action==='login'), 'debe haber evento login');
  assert.ok(audit.some(e=>e.action==='stock_adjustment'), 'debe haber ajuste de stock');
});

test('vigencia del plan (D2): empresa vencida corta e invalida la sesión activa', async () => {
  await api('POST', '/tenants', { token:superToken, body:{ name:'EXPIRED_CO' } });
  const list = (await api('GET', '/tenants', { token:superToken })).json;
  const exp = list.find(t=>t.name==='EXPIRED_CO');
  await api('POST', '/users', { token:superToken, body:{ username:'expAdmin', password:'expClave123', role:'admin', tenant_id:exp.id } });
  const tok = (await login('EXPIRED_CO', 'expAdmin', 'expClave123')).json.token;
  assert.strictEqual((await api('GET', '/products', { token:tok })).status, 200);
  // superadmin vence la empresa (vence ayer)
  const patch = await api('PATCH', `/tenants/${exp.id}`, { token:superToken, body:{ vence:'2020-01-01', confirm_password:'SuperClave123' } });
  assert.strictEqual(patch.status, 200);
  const vencido = await api('GET', '/products', { token:tok });
  assert.strictEqual(vencido.status, 403);
  assert.strictEqual(vencido.json.error.code, 'EMPRESA_VENCIDA');
  const reintento = await api('GET', '/products', { token:tok });
  assert.strictEqual(reintento.status, 401, 'sesión invalidada tras vencer');
});

// ---- Fase E: Clientes (CRM) ----
test('clientes: crear, listar y validar nombre obligatorio', async () => {
  const sinNombre = await api('POST', '/customers', { token:demoToken, body:{ phone:'300' } });
  assert.strictEqual(sinNombre.status, 400);
  const c = await api('POST', '/customers', { token:demoToken, body:{ name:'Juan Pérez', doc:'123', phone:'3001112233', credit_limit:5000 } });
  assert.strictEqual(c.status, 201);
  assert.strictEqual(c.json.credit_limit, 5000);
  const list = (await api('GET', '/customers', { token:demoToken })).json;
  assert.ok(list.some(x=>x.id===c.json.id), 'cliente debe aparecer en el listado');
});

test('venta con customer_id denormaliza el nombre y guarda el id', async () => {
  const cliente = (await api('POST', '/customers', { token:demoToken, body:{ name:'Cliente Contado' } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ItemCliente', price:1190, cost:500, stock:10 } })).json;
  const venta = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:1 }], customer_id:cliente.id } });
  assert.strictEqual(venta.status, 201);
  assert.strictEqual(venta.json.customer_id, cliente.id);
  assert.strictEqual(venta.json.customer, 'Cliente Contado', 'nombre denormalizado desde el cliente');
});

test('cupo de crédito: venta a crédito que excede el límite -> 409 CUPO_EXCEDIDO', async () => {
  const cliente = (await api('POST', '/customers', { token:demoToken, body:{ name:'Cliente Cupo', credit_limit:5000 } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ItemCupo', price:11900, cost:5000, stock:10 } })).json;
  const r = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:1 }], customer_id:cliente.id, pay_status:'credito' } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'CUPO_EXCEDIDO');
});

test('detalle de cliente devuelve historial y saldo a crédito', async () => {
  const cliente = (await api('POST', '/customers', { token:demoToken, body:{ name:'Cliente Saldo', credit_limit:100000 } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ItemSaldo', price:10000, cost:4000, stock:10 } })).json;
  await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:1 }], customer_id:cliente.id, pay_status:'credito' } });
  const det = (await api('GET', `/customers/${cliente.id}`, { token:demoToken })).json;
  assert.strictEqual(det.saldo, 10000, 'saldo = venta a crédito');
  assert.strictEqual(det.ventas.length, 1);
  assert.strictEqual(det.cupoDisponible, 90000);
});

// ---- Fase F: Devoluciones / notas crédito ----
test('devolución parcial reingresa stock y emite nota crédito', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ItemDevol', price:10000, cost:4000, stock:10 } })).json;
  const venta = (await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:5 }] } })).json;
  let stock = (await api('GET', '/products', { token:demoToken })).json.find(x=>x.id===p.id).stock;
  assert.strictEqual(stock, 5, 'tras vender 5: stock 5');
  const nc = await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.id, items:[{ product_id:p.id, qty:2 }], motivo:'defectuoso' } });
  assert.strictEqual(nc.status, 201);
  assert.ok(/^NC-\d{5}$/.test(nc.json.numero), 'número de nota crédito');
  assert.strictEqual(nc.json.total, 20000);
  stock = (await api('GET', '/products', { token:demoToken })).json.find(x=>x.id===p.id).stock;
  assert.strictEqual(stock, 7, 'tras devolver 2: stock 5+2=7');
});

test('no se puede devolver más de lo vendido (acumulado)', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ItemTope', price:1000, cost:400, stock:10 } })).json;
  const venta = (await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:3 }] } })).json;
  await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.id, items:[{ product_id:p.id, qty:2 }] } });
  const exceso = await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.id, items:[{ product_id:p.id, qty:2 }] } }); // ya devolvió 2, quedan 1
  assert.strictEqual(exceso.status, 409);
  assert.strictEqual(exceso.json.error.code, 'CANTIDAD_EXCEDE');
});

test('devolver un producto que no está en la venta -> 409', async () => {
  const p1 = (await api('POST', '/products', { token:demoToken, body:{ name:'EnVenta', price:1000, cost:400, stock:5 } })).json;
  const p2 = (await api('POST', '/products', { token:demoToken, body:{ name:'FueraDeVenta', price:1000, cost:400, stock:5 } })).json;
  const venta = (await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p1.id, qty:1 }] } })).json;
  const r = await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.id, items:[{ product_id:p2.id, qty:1 }] } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'PRODUCTO_NO_EN_VENTA');
});

test('finanzas reflejan las devoluciones (reembolso reduce ingresos)', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ItemFin', price:5000, cost:2000, stock:10 } })).json;
  const venta = (await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:2 }] } })).json; // pagada, total 10000
  await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.id, items:[{ product_id:p.id, qty:1 }] } }); // refund 5000
  const fin = (await api('GET', '/finance', { token:demoToken })).json;
  assert.ok(fin.devoluciones >= 5000, 'finanzas reportan devoluciones');
});

// ---- Fase G: IMEI / serial ----
test('IMEI: registrar unidades, rechazar duplicado y lookup', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'Celular X', price:1000000, cost:700000, stock:2, device:1 } })).json;
  const u1 = await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'IMEI-AAA-1' } });
  assert.strictEqual(u1.status, 201);
  assert.strictEqual(u1.json.status, 'disponible');
  await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'IMEI-AAA-2' } });
  const dup = await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'IMEI-AAA-1' } });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.json.error.code, 'IMEI_EXISTE');
  const list = (await api('GET', `/products/${p.id}/units`, { token:demoToken })).json;
  assert.strictEqual(list.length, 2);
  const look = await api('GET', '/units/lookup?imei=IMEI-AAA-1', { token:demoToken });
  assert.strictEqual(look.status, 200);
  assert.strictEqual(look.json.imei, 'IMEI-AAA-1');
});

test('IMEI: venta marca unidades vendidas; devolución las libera', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'Celular Y', price:1000000, cost:700000, stock:2, device:1 } })).json;
  await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'YY-1' } });
  await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'YY-2' } });
  const venta = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:2, imeis:['YY-1','YY-2'] }] } });
  assert.strictEqual(venta.status, 201);
  let units = (await api('GET', `/products/${p.id}/units`, { token:demoToken })).json;
  assert.ok(units.every(u=>u.status==='vendido' && u.sale_id===venta.json.id), 'ambas vendidas y ligadas a la venta');
  await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.json.id, items:[{ product_id:p.id, qty:1, imeis:['YY-1'] }] } });
  units = (await api('GET', `/products/${p.id}/units`, { token:demoToken })).json;
  assert.strictEqual(units.find(u=>u.imei==='YY-1').status, 'disponible', 'YY-1 liberada');
  assert.strictEqual(units.find(u=>u.imei==='YY-1').sale_id, null);
  assert.strictEqual(units.find(u=>u.imei==='YY-2').status, 'vendido', 'YY-2 sigue vendida');
});

test('IMEI: cantidad no coincide / inexistente -> 409; baja de disponible OK', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'Celular Z', price:500000, cost:300000, stock:2, device:1 } })).json;
  const u = (await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'ZZ-1' } })).json;
  await api('POST', `/products/${p.id}/units`, { token:demoToken, body:{ imei:'ZZ-2' } });
  const mal = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:2, imeis:['ZZ-1'] }] } });
  assert.strictEqual(mal.status, 409);
  assert.strictEqual(mal.json.error.code, 'IMEI_CANTIDAD');
  const inv = await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:1, imeis:['NO-EXISTE'] }] } });
  assert.strictEqual(inv.status, 409);
  assert.strictEqual(inv.json.error.code, 'IMEI_INVALIDO');
  const baja = await api('DELETE', `/units/${u.id}`, { token:demoToken });
  assert.strictEqual(baja.status, 200);
  assert.strictEqual(baja.json.status, 'baja');
});

// ---- Fase H: Multi-sucursal (stock por sucursal) ----
test('sucursales: existe Principal por defecto y se puede crear otra', async () => {
  const list = (await api('GET', '/branches', { token:demoToken })).json;
  assert.ok(list.some(b=>b.name==='Principal'), 'la empresa tiene sucursal Principal');
  const nueva = await api('POST', '/branches', { token:demoToken, body:{ name:'Sucursal Norte' } });
  assert.strictEqual(nueva.status, 201);
});

test('stock por sucursal: producto nace en Principal; compra a otra sucursal suma al total', async () => {
  const principal = (await api('GET', '/branches', { token:demoToken })).json.find(b=>b.name==='Principal');
  const norte = (await api('POST', '/branches', { token:demoToken, body:{ name:'Norte2' } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ProdSuc', price:1000, cost:400, stock:5 } })).json;
  let st = (await api('GET', `/products/${p.id}/stock`, { token:demoToken })).json;
  assert.strictEqual(st.find(s=>s.branch_id===principal.id).qty, 5, 'nace con 5 en Principal');
  await api('POST', '/purchases', { token:demoToken, body:{ branch_id:norte.id, items:[{ product_id:p.id, qty:10, cost:400 }] } });
  st = (await api('GET', `/products/${p.id}/stock`, { token:demoToken })).json;
  assert.strictEqual(st.find(s=>s.branch_id===norte.id).qty, 10, 'Norte tiene 10');
  const total = (await api('GET', '/products', { token:demoToken })).json.find(x=>x.id===p.id).stock;
  assert.strictEqual(total, 15, 'total = 5 + 10');
});

test('venta descuenta de la sucursal indicada; sin stock en esa sucursal -> 409', async () => {
  const principal = (await api('GET', '/branches', { token:demoToken })).json.find(b=>b.name==='Principal');
  const otra = (await api('POST', '/branches', { token:demoToken, body:{ name:'Otra3' } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ProdVtaSuc', price:1000, cost:400, stock:3 } })).json;
  const ok = await api('POST', '/sales', { token:demoToken, body:{ branch_id:principal.id, items:[{ product_id:p.id, qty:2 }] } });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.branch_id, principal.id);
  const bad = await api('POST', '/sales', { token:demoToken, body:{ branch_id:otra.id, items:[{ product_id:p.id, qty:1 }] } });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.json.error.code, 'STOCK_INSUFICIENTE');
  const total = (await api('GET', '/products', { token:demoToken })).json.find(x=>x.id===p.id).stock;
  assert.strictEqual(total, 1, 'total = 3 - 2');
});

test('no se puede eliminar sucursal con stock; sí tras vaciarla', async () => {
  const suc = (await api('POST', '/branches', { token:demoToken, body:{ name:'ParaBorrar' } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ProdBorrar', price:1000, cost:400, stock:0 } })).json;
  await api('POST', '/purchases', { token:demoToken, body:{ branch_id:suc.id, items:[{ product_id:p.id, qty:3, cost:400 }] } });
  const conStock = await api('DELETE', `/branches/${suc.id}`, { token:demoToken });
  assert.strictEqual(conStock.status, 409);
  assert.strictEqual(conStock.json.error.code, 'SUCURSAL_CON_STOCK');
  await api('POST', '/adjustments', { token:demoToken, body:{ branch_id:suc.id, product_id:p.id, type:'ajuste', qty:0 } });
  const vacia = await api('DELETE', `/branches/${suc.id}`, { token:demoToken });
  assert.strictEqual(vacia.status, 200);
});

// ---- Fase I: Caja / arqueo / turnos ----
test('caja: abrir, vender en efectivo, cerrar y arquear (cuadrada)', async () => {
  const principal = (await api('GET', '/branches', { token:demoToken })).json.find(b=>b.name==='Principal');
  const open = await api('POST', '/cash-sessions', { token:demoToken, body:{ branch_id:principal.id, opening_amount:50000 } });
  assert.strictEqual(open.status, 201);
  const sid = open.json.id;
  const dup = await api('POST', '/cash-sessions', { token:demoToken, body:{ opening_amount:1000 } });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.json.error.code, 'CAJA_ABIERTA');
  const cur = (await api('GET', '/cash-sessions/current', { token:demoToken })).json;
  assert.strictEqual(cur.id, sid);
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ProdCaja', price:10000, cost:4000, stock:10 } })).json;
  const venta = await api('POST', '/sales', { token:demoToken, body:{ branch_id:principal.id, items:[{ product_id:p.id, qty:2 }], pay_method:'efectivo' } });
  assert.strictEqual(venta.json.cash_session_id, sid, 'venta ligada a la caja abierta');
  const close = await api('POST', `/cash-sessions/${sid}/close`, { token:demoToken, body:{ counted_amount:70000 } });
  assert.strictEqual(close.status, 200);
  assert.strictEqual(close.json.expected_amount, 70000, 'esperado = 50000 fondo + 20000 venta');
  assert.strictEqual(close.json.difference, 0);
  assert.strictEqual(close.json.status, 'cerrada');
  const re = await api('POST', `/cash-sessions/${sid}/close`, { token:demoToken, body:{ counted_amount:1 } });
  assert.strictEqual(re.status, 409);
  assert.strictEqual(re.json.error.code, 'CAJA_CERRADA');
});

test('caja: arqueo detecta descuadre y resta devoluciones en efectivo', async () => {
  const open = (await api('POST', '/cash-sessions', { token:demoToken, body:{ opening_amount:0 } })).json;
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ProdCaja2', price:10000, cost:4000, stock:10 } })).json;
  const venta = (await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:3 }], pay_method:'efectivo' } })).json; // +30000
  await api('POST', '/returns', { token:demoToken, body:{ sale_id:venta.id, items:[{ product_id:p.id, qty:1 }] } }); // -10000
  const close = await api('POST', `/cash-sessions/${open.id}/close`, { token:demoToken, body:{ counted_amount:18000 } });
  assert.strictEqual(close.json.expected_amount, 20000, 'esperado = 30000 - 10000 devolución');
  assert.strictEqual(close.json.difference, -2000, 'faltante de 2000');
});

// ---- Fase J: código de barras + recibo ----
test('código de barras: lookup encuentra producto; desconocido -> 404', async () => {
  await api('POST', '/products', { token:demoToken, body:{ name:'ConBarcode', barcode:'7700001', price:1000, cost:400, stock:1 } });
  const ok = await api('GET', '/products/lookup?barcode=7700001', { token:demoToken });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.barcode, '7700001');
  const no = await api('GET', '/products/lookup?barcode=NOEXISTE', { token:demoToken });
  assert.strictEqual(no.status, 404);
});

test('GET /sales/:id devuelve la venta (datos del recibo)', async () => {
  const p = (await api('POST', '/products', { token:demoToken, body:{ name:'ProdRecibo', price:5000, cost:2000, stock:5 } })).json;
  const venta = (await api('POST', '/sales', { token:demoToken, body:{ items:[{ product_id:p.id, qty:1 }] } })).json;
  const got = await api('GET', `/sales/${venta.id}`, { token:demoToken });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.json.id, venta.id);
  assert.strictEqual((await api('GET', '/sales/999999', { token:demoToken })).status, 404);
});

// ---- Fase K: email + recuperación de contraseña ----
test('recuperación de contraseña: forgot emite token (dev) y reset cambia la clave', async () => {
  await api('POST', '/company/users', { token:demoToken, body:{ name:'Cajero', username:'cajero1', email:'cajero1@demo.co', password:'ClaveVieja1', role:'tienda' } });
  const forgot = await api('POST', '/auth/forgot', { body:{ empresa:'JEROTECH', username:'cajero1' } });
  assert.strictEqual(forgot.status, 200);
  assert.ok(forgot.json.dev_token, 'dev_token presente fuera de producción');
  const reset = await api('POST', '/auth/reset', { body:{ token:forgot.json.dev_token, password:'ClaveNueva1' } });
  assert.strictEqual(reset.status, 200);
  const login = await api('POST', '/auth/login', { body:{ empresa:'JEROTECH', username:'cajero1', password:'ClaveNueva1' } });
  assert.strictEqual(login.status, 200);
  assert.ok(login.json.token, 'login con la nueva contraseña');
  const ghost = await api('POST', '/auth/forgot', { body:{ empresa:'JEROTECH', username:'fantasma' } });
  assert.strictEqual(ghost.status, 200);
  assert.ok(!ghost.json.dev_token, 'sin token para usuario inexistente (anti-enumeración)');
});

test('reset con token inválido -> 400', async () => {
  const r = await api('POST', '/auth/reset', { body:{ token:'noexiste', password:'OtraClave1' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'TOKEN_INVALIDO');
});

// ---- Fase L: planes, vigencia y facturación ----
test('crear empresa con plan y costo genera factura de servicio', async () => {
  const r = await api('POST', '/tenants', { token:superToken, body:{ name:'PLAN_CO', email:'plan@co.test', plan:'Premium', plan_cost:120000, vence:'2030-12-31' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.plan, 'Premium');
  assert.strictEqual(r.json.plan_cost, 120000);
  assert.ok(r.json.factura && /^SVC-\d{5}$/.test(r.json.factura.numero), 'factura emitida');
  assert.strictEqual(r.json.factura.amount, 120000);
  const invs = await api('GET', `/tenants/${r.json.id}/invoices`, { token:superToken });
  assert.strictEqual(invs.status, 200);
  assert.ok(invs.json.length >= 1);
});

test('días restantes y auto-desactivación por vencimiento', async () => {
  const exp = await api('POST', '/tenants', { token:superToken, body:{ name:'VENCIDA_CO', vence:'2020-01-01', plan:'Básico', plan_cost:1000 } });
  await api('POST', '/users', { token:superToken, body:{ username:'vadmin', password:'ClaveVenc1', role:'admin', tenant_id:exp.json.id } });
  const list = (await api('GET', '/tenants', { token:superToken })).json;
  const t = list.find(x=>x.id===exp.json.id);
  assert.ok(t.dias_restantes < 0, 'días restantes negativos');
  assert.strictEqual(t.status, 'inactivo', 'auto-desactivada al vencer');
  const lg = await api('POST', '/auth/login', { body:{ empresa:'VENCIDA_CO', username:'vadmin', password:'ClaveVenc1' } });
  assert.strictEqual(lg.status, 403, 'login bloqueado por vencimiento');
});

test('usuario asignado a una sede (branch_id)', async () => {
  const t = await api('POST', '/tenants', { token:superToken, body:{ name:'SEDE_CO' } });
  const brs = await api('GET', `/tenants/${t.json.id}/branches`, { token:superToken });
  assert.strictEqual(brs.status, 200);
  assert.ok(brs.json.length >= 1, 'tiene sucursal Principal');
  const bid = brs.json[0].id;
  await api('POST', '/users', { token:superToken, body:{ username:'sedeuser', password:'ClaveSede1', role:'tienda', tenant_id:t.json.id, branch_id:bid } });
  const u = (await api('GET', '/users', { token:superToken })).json.find(x=>x.username==='sedeuser');
  assert.strictEqual(u.branch_id, bid, 'usuario ligado a la sede');
});
