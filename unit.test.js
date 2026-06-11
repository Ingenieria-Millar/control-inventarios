// Tests unitarios de las funciones de agregación puras (no requieren servidor ni BD).
const { test } = require('node:test');
const assert = require('node:assert');

// Forzar modo JSON con archivo temporal antes de cargar el módulo.
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-unit.json');
delete process.env.DATABASE_URL;
const { buildReport, buildFinance, buildInsights } = require('../server.js');

const products = [
  { id:1, name:'A', price:11900, cost:5000, stock:10, stock_min:5 },
  { id:2, name:'B', price:1000,  cost:950,  stock:0,  stock_min:3 }, // margen bajo + agotado
  { id:3, name:'C', price:2000,  cost:500,  stock:7,  stock_min:2 }  // sin rotación
];
const sales = [
  { id:1, fecha:'2026-06-10T10:00:00.000Z', total:23800, subtotal:20000, iva:3800, pay_status:'pagada',
    items:[{ product_id:1, name:'A', qty:2, total:23800 }] },
  { id:2, fecha:'2026-06-10T11:00:00.000Z', total:1000, subtotal:840, iva:160, pay_status:'credito',
    items:[{ product_id:2, name:'B', qty:1, total:1000 }] }
];
const purchases = [
  { id:1, fecha:'2026-06-10T09:00:00.000Z', total:50000, pay_status:'pagada', proveedor:'P', numero:'E-1' },
  { id:2, fecha:'2026-06-10T09:00:00.000Z', total:9000,  pay_status:'credito', proveedor:'Q', numero:'E-2' }
];
const expenses = [
  { id:1, fecha:'2026-06-10T12:00:00.000Z', categoria:'Arriendo', descripcion:'', monto:30000 },
  { id:2, fecha:'2026-06-10T12:00:00.000Z', categoria:'Arriendo', descripcion:'', monto:10000 }
];
const FROM='2026-06-01', TO='2026-06-30';

test('buildReport: totales, IVA y utilidad', () => {
  const r = buildReport(sales, purchases, products, FROM, TO);
  assert.strictEqual(r.ventas.count, 2);
  assert.strictEqual(r.ventas.total, 24800);
  assert.strictEqual(r.compras.total, 59000);
  // utilidad = base vendida - costo vendido
  assert.ok(r.utilidad < r.ventas.base, 'utilidad debe descontar costo');
  assert.strictEqual(r.inventario.productos, 3);
  assert.strictEqual(r.inventario.bajoStock, 1); // solo B (stock 0 < min 3); A(10>=5) y C(7>=2) ok
});

test('buildReport: fuera de rango excluye ventas', () => {
  const r = buildReport(sales, purchases, products, '2025-01-01', '2025-12-31');
  assert.strictEqual(r.ventas.count, 0);
  assert.strictEqual(r.ventas.total, 0);
});

test('buildFinance: flujo neto excluye crédito de ingresos/egresos y suma gastos', () => {
  const f = buildFinance(sales, purchases, expenses, FROM, TO);
  assert.strictEqual(f.ingresos, 23800);        // solo venta pagada
  assert.strictEqual(f.egresosCompras, 50000);  // solo compra pagada
  assert.strictEqual(f.egresosGastos, 40000);   // 30000 + 10000
  assert.strictEqual(f.flujoNeto, 23800 - 50000 - 40000);
  assert.strictEqual(f.porCobrarTotal, 1000);   // venta a crédito
  assert.strictEqual(f.porPagarTotal, 9000);    // compra a crédito
  assert.strictEqual(f.gastosPorCategoria[0].categoria, 'Arriendo');
  assert.strictEqual(f.gastosPorCategoria[0].monto, 40000);
});

test('buildInsights: agotados, sin rotación y margen bajo', () => {
  const i = buildInsights(products, sales, FROM, TO);
  assert.ok(i.agotados.some(p=>p.name==='B'), 'B agotado');
  assert.ok(i.sinRotacion.some(p=>p.name==='C'), 'C sin ventas');
  assert.ok(i.margenBajo.some(p=>p.name==='B'), 'B margen < 15%');
  assert.strictEqual(i.topVendido.name, 'A'); // 2 unidades, el más vendido
});
