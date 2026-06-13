// app-core.js — Nexo Retail: multiempresa + usuarios + inventario + POS
// Persistencia: PostgreSQL si existe DATABASE_URL; si no, archivo JSON (respaldo).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = !!DATABASE_URL;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'nexo.json');

// ----- RLS (Row Level Security) a nivel base de datos -----
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();           // contexto de empresa por petición
let RLS_ON = false;                            // true solo con PostgreSQL real
const RLS_TABLES = ['products','sales','movements','purchases','expenses','users','customers','returns','units','branches','branch_stock','cash_sessions'];
function rlsStatements(){
  const out=[];
  const pol = "current_setting('app.super', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int";
  for(const t of RLS_TABLES){
    out.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    out.push(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    out.push(`DROP POLICY IF EXISTS nexo_isolation ON ${t}`);
    out.push(`CREATE POLICY nexo_isolation ON ${t} USING (${pol}) WITH CHECK (${pol})`);
  }
  return out;
}
// Fija el contexto de empresa DENTRO de una transacción (para métodos transaccionales)
async function setLocalCtx(client, tid){ if(!RLS_ON) return; await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.super',$2,true)",[tid==null?'':String(tid), tid==null?'on':'off']); }
// Sucursales (modo PostgreSQL, dentro de una transacción)
async function pgResolveBranch(client, tid, branchId){ if(branchId!=null && branchId!==''){ const b=await client.query('SELECT * FROM branches WHERE id=$1 AND tenant_id=$2',[Number(branchId),tid]); if(!b.rows[0]) throw { code:'SUCURSAL_INVALIDA', message:'Sucursal no válida' }; if(b.rows[0].status!=='activo') throw { code:'SUCURSAL_INACTIVA', message:'Sucursal inactiva' }; return b.rows[0].id; } const r=await client.query('SELECT id FROM branches WHERE tenant_id=$1 ORDER BY id LIMIT 1',[tid]); if(r.rows[0]) return r.rows[0].id; const ins=await client.query(`INSERT INTO branches(tenant_id,name) VALUES($1,'Principal') RETURNING id`,[tid]); return ins.rows[0].id; }
async function pgBranchQty(client, tid, pid, bid){ await client.query('INSERT INTO branch_stock(tenant_id,product_id,branch_id,qty) VALUES($1,$2,$3,0) ON CONFLICT (product_id,branch_id) DO NOTHING',[tid,pid,bid]); const r=await client.query('SELECT qty FROM branch_stock WHERE product_id=$1 AND branch_id=$2 FOR UPDATE',[pid,bid]); return Number(r.rows[0].qty); }

const seedProducts = [
  { name:'iPhone 15 128GB', sku:'APL-I15-128', brand:'Apple', category:'Celulares', emoji:'📱', price:4299900, cost:3150000, stock:8,  stock_min:5,  device:1, compat:[] },
  { name:'Samsung Galaxy S24', sku:'SAM-S24-256', brand:'Samsung', category:'Celulares', emoji:'📱', price:3899900, cost:2820000, stock:3,  stock_min:5,  device:1, compat:[] },
  { name:'Xiaomi Redmi Note 13', sku:'XIA-RN13', brand:'Xiaomi', category:'Celulares', emoji:'📱', price:1099900, cost:720000,  stock:14, stock_min:6,  device:1, compat:[] },
  { name:'Motorola Edge 50', sku:'MOT-E50', brand:'Motorola', category:'Celulares', emoji:'📱', price:1599900, cost:1100000, stock:0,  stock_min:4,  device:1, compat:[] },
  { name:'Cargador USB-C 30W', sku:'ACC-CHG-30', brand:'Genérico', category:'Cargadores', emoji:'🔌', price:79900, cost:38000, stock:42, stock_min:15, device:0, compat:[1,2,3,4] },
  { name:'AirPods Pro 2', sku:'APL-APP2', brand:'Apple', category:'Audio', emoji:'🎧', price:899900, cost:620000, stock:6, stock_min:4, device:0, compat:[1] },
  { name:'Vidrio templado iPhone 15', sku:'ACC-VT-I15', brand:'Genérico', category:'Protección', emoji:'🛡️', price:29900, cost:9000, stock:55, stock_min:20, device:0, compat:[1] },
  { name:'Funda silicona iPhone 15', sku:'ACC-FN-I15', brand:'Genérico', category:'Protección', emoji:'📲', price:39900, cost:14000, stock:4, stock_min:10, device:0, compat:[1] },
  { name:'Vidrio templado Galaxy S24', sku:'ACC-VT-S24', brand:'Genérico', category:'Protección', emoji:'🛡️', price:27900, cost:8500, stock:30, stock_min:15, device:0, compat:[2] },
  { name:'Funda Galaxy S24', sku:'ACC-FN-S24', brand:'Genérico', category:'Protección', emoji:'📲', price:35900, cost:13000, stock:18, stock_min:10, device:0, compat:[2] },
  { name:'Audífonos Galaxy Buds', sku:'SAM-BUDS', brand:'Samsung', category:'Audio', emoji:'🎧', price:349900, cost:260000, stock:9, stock_min:4, device:0, compat:[2,3] },
  { name:'Power Bank 20.000mAh', sku:'ACC-PB-20', brand:'Genérico', category:'Energía', emoji:'🔋', price:129900, cost:70000, stock:22, stock_min:8, device:0, compat:[1,2,3,4] },
  { name:'Vidrio templado Redmi 13', sku:'ACC-VT-RN13', brand:'Genérico', category:'Protección', emoji:'🛡️', price:24900, cost:7500, stock:2, stock_min:12, device:0, compat:[3] },
  { name:'Cable USB-C a Lightning', sku:'ACC-CBL-CL', brand:'Apple', category:'Cargadores', emoji:'🔌', price:89900, cost:45000, stock:16, stock_min:8, device:0, compat:[1] }
];

// ---------- Cripto ----------
function hashPw(pw){ const salt=crypto.randomBytes(16).toString('hex'); const hash=crypto.scryptSync(String(pw),salt,64).toString('hex'); return { hash, salt }; }
function verifyPw(pw,hash,salt){ try{ const h=crypto.scryptSync(String(pw),salt,64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(String(hash),'hex')); }catch(e){ return false; } }
function randomToken(){ return crypto.randomBytes(24).toString('hex'); }

// ---------- Email: configurable por entorno; stub si no hay SMTP (nodemailer opcional) ----------
async function sendEmail(to, subject, text){
  if(!to) return { sent:false, reason:'sin destinatario' };
  const url=process.env.SMTP_URL, from=process.env.SMTP_FROM||'no-reply@nexo.local';
  if(!url){ console.log(`[email:stub] para=${to} asunto="${subject}"`); return { sent:false, reason:'SMTP no configurado' }; }
  try{ const nodemailer=require('nodemailer'); const t=nodemailer.createTransport(url); await t.sendMail({ from, to, subject, text }); return { sent:true }; }
  catch(e){ console.error('Email falló:', e.message); return { sent:false, reason:e.message }; }
}

// ---------- Rate limiting / lockout de login (en memoria, 1 instancia) ----------
const LOGIN_MAX_FAILS = 5;             // fallos seguidos por cuenta antes de bloquear
const LOGIN_LOCK_MS   = 15*60*1000;    // duración del bloqueo: 15 min
const IP_MAX_HITS     = 30;            // intentos de login por IP
const IP_WINDOW_MS    = 5*60*1000;     // ventana por IP: 5 min
const loginAttempts = new Map();       // "empresa|usuario" -> { fails, lockedUntil }
const ipHits = new Map();              // ip -> { count, resetAt }
function loginKey(empresa,username){ return String(empresa||'').trim().toLowerCase()+'|'+String(username||'').trim().toLowerCase(); }
function loginLockedMin(key){ const e=loginAttempts.get(key); if(e&&e.lockedUntil>Date.now()) return Math.ceil((e.lockedUntil-Date.now())/60000); return 0; }
function loginFail(key){ const e=loginAttempts.get(key)||{ fails:0, lockedUntil:0 }; e.fails++; if(e.fails>=LOGIN_MAX_FAILS){ e.lockedUntil=Date.now()+LOGIN_LOCK_MS; e.fails=0; } loginAttempts.set(key,e); }
function loginOk(key){ loginAttempts.delete(key); }
function ipThrottled(ip){ const now=Date.now(); let e=ipHits.get(ip); if(!e||e.resetAt<now){ e={ count:0, resetAt:now+IP_WINDOW_MS }; ipHits.set(ip,e); } e.count++; return e.count>IP_MAX_HITS; }
const _rlCleanup=setInterval(()=>{ const now=Date.now(); for(const [k,e] of loginAttempts){ if(e.lockedUntil<now && !e.fails) loginAttempts.delete(k); } for(const [k,e] of ipHits){ if(e.resetAt<now) ipHits.delete(k); } }, 10*60*1000); if(_rlCleanup.unref) _rlCleanup.unref();

// =======================================================
//  REPOSITORIO JSON (archivo) — respaldo / desarrollo
// =======================================================
let data = {};
function nextId(k){ data.counters[k]=(data.counters[k]||0)+1; return data.counters[k]; }
function saveJson(){ if(USE_PG) return; fs.mkdirSync(path.dirname(DB_PATH),{recursive:true}); fs.writeFileSync(DB_PATH, JSON.stringify(data,null,2)); }
function loadJson(){
  try{ data = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH,'utf8')) : {}; }
  catch(e){ console.error('JSON corrupto, se reinicia:', e.message); data = {}; }
  data.tenants=data.tenants||[]; data.users=data.users||[]; data.sessions=data.sessions||[];
  data.products=data.products||[]; data.sales=data.sales||[]; data.movements=data.movements||[];
  data.purchases=data.purchases||[];
  data.expenses=data.expenses||[];
  data.audit=data.audit||[];
  data.customers=data.customers||[];
  data.returns=data.returns||[];
  data.units=data.units||[];
  data.branches=data.branches||[];
  data.branchStock=data.branchStock||[];
  data.cashSessions=data.cashSessions||[];
  data.passwordResets=data.passwordResets||[];
  data.serviceInvoices=data.serviceInvoices||[];
  data.counters=data.counters||{};
  const mx=a=>a.reduce((m,x)=>Math.max(m,x.id||0),0);
  ['tenant','user','product','sale','movement','purchase','expense','audit','customer','return','unit','branch','cashsession','sinvoice'].forEach(k=>{ if(data.counters[k]==null) data.counters[k]=0; });
  data.counters.tenant=Math.max(data.counters.tenant,mx(data.tenants));
  data.counters.user=Math.max(data.counters.user,mx(data.users));
  data.counters.product=Math.max(data.counters.product,mx(data.products));
  data.counters.sale=Math.max(data.counters.sale,mx(data.sales));
  data.counters.movement=Math.max(data.counters.movement,mx(data.movements));
  data.counters.purchase=Math.max(data.counters.purchase,mx(data.purchases));
  data.counters.expense=Math.max(data.counters.expense,mx(data.expenses));
  data.counters.audit=Math.max(data.counters.audit,mx(data.audit));
  data.counters.customer=Math.max(data.counters.customer,mx(data.customers));
  data.counters.return=Math.max(data.counters.return,mx(data.returns));
  data.counters.unit=Math.max(data.counters.unit,mx(data.units));
  data.counters.branch=Math.max(data.counters.branch,mx(data.branches));
  data.counters.cashsession=Math.max(data.counters.cashsession,mx(data.cashSessions));
  data.counters.sinvoice=Math.max(data.counters.sinvoice,mx(data.serviceInvoices));
  // Normaliza el perfil principal: "Súper Admin" -> "Soporte"
  data.users.forEach(u=>{ if(u.role==='superadmin' && (u.name==='Súper Admin'||u.username==='Súper Admin')){ u.name='Soporte'; u.username='Soporte'; } });
  reconcileBranches();
}
// ----- Helpers de sucursales (modo JSON) -----
function jsonBranchRow(tid,pid,bid){ let s=data.branchStock.find(x=>x.product_id===Number(pid)&&x.branch_id===Number(bid)); if(!s){ s={ tenant_id:tid, product_id:Number(pid), branch_id:Number(bid), qty:0 }; data.branchStock.push(s); } return s; }
function jsonDefaultBranchId(tid){ const bs=data.branches.filter(b=>b.tenant_id===tid).sort((a,b)=>a.id-b.id); if(bs[0]) return bs[0].id; const b={ id:nextId('branch'), tenant_id:tid, name:'Principal', address:'', phone:'', status:'activo', created_at:new Date().toISOString() }; data.branches.push(b); return b.id; }
// Crea sucursal "Principal" y stock por sucursal para datos preexistentes (idempotente)
function reconcileBranches(){
  for(const t of data.tenants){ if(!data.branches.some(b=>b.tenant_id===t.id)) data.branches.push({ id:nextId('branch'), tenant_id:t.id, name:'Principal', address:'', phone:'', status:'activo', created_at:new Date().toISOString() }); }
  for(const p of data.products){ if(!data.branchStock.some(s=>s.product_id===p.id)){ const bid=jsonDefaultBranchId(p.tenant_id); data.branchStock.push({ tenant_id:p.tenant_id, product_id:p.id, branch_id:bid, qty:Number(p.stock)||0 }); } }
}
const jsonRepo = {
  async countUsers(){ return data.users.length; },
  // Auditoría
  async logAudit(e){ const row={ id:nextId('audit'), ts:new Date().toISOString(), actor_user_id:e.actor_user_id==null?null:Number(e.actor_user_id), actor_name:e.actor_name||null, actor_role:e.actor_role||null, tenant_id:e.tenant_id==null?null:Number(e.tenant_id), action:e.action, entity:e.entity||null, entity_id:e.entity_id==null?null:Number(e.entity_id), detail:e.detail||null, ip:e.ip||null }; data.audit.push(row); saveJson(); return row; },
  async listAudit({ tenant_id=null, limit=200 }={}){ let rows=data.audit; if(tenant_id!=null) rows=rows.filter(r=>r.tenant_id===Number(tenant_id)); return rows.slice().sort((a,b)=>b.id-a.id).slice(0, Math.max(1,Number(limit)||200)); },
  // Tenants
  async createTenant(o){ const t={ id:nextId('tenant'), name:o.name, code:(o.code||'').toUpperCase()||null, nit:o.nit||'', email:o.email||null, contacto:o.contacto||null, telefono:o.telefono||null, vence:o.vence||null, fecha_inicio:o.fecha_inicio||null, fecha_creacion:o.fecha_creacion||null, plan:o.plan||null, plan_tipo:o.plan_tipo||null, plan_cost:Number(o.plan_cost)||0, logo:o.logo||null, status:'activo', created_at:new Date().toISOString() }; data.tenants.push(t); data.branches.push({ id:nextId('branch'), tenant_id:t.id, name:'Principal', address:'', phone:'', status:'activo', created_at:new Date().toISOString() }); saveJson(); return t; },
  async getTenant(id){ return data.tenants.find(t=>t.id===Number(id)) || null; },
  async findTenantByCode(code){ const c=String(code||'').toUpperCase(); return data.tenants.find(t=>(t.code||'').toUpperCase()===c) || null; },
  async findTenantByName(name){ const n=String(name||'').trim().toLowerCase(); return data.tenants.find(t=>(t.name||'').trim().toLowerCase()===n) || null; },
  async listTenants(){ const today=new Date().toISOString().slice(0,10); let changed=false; data.tenants.forEach(t=>{ if(t.vence && today>String(t.vence).slice(0,10) && t.status==='activo'){ t.status='inactivo'; changed=true; } }); if(changed) saveJson(); return data.tenants.map(t=>({ ...t, plan_cost:Number(t.plan_cost)||0, dias_restantes:diasRestantes(t.vence), users:data.users.filter(u=>u.tenant_id===t.id).length, products:data.products.filter(p=>p.tenant_id===t.id).length })); },
  async updateTenant(id,f){ const t=data.tenants.find(x=>x.id===Number(id)); if(!t) return null; if(f.status) t.status=f.status; if(f.name) t.name=f.name; if(f.nit!==undefined) t.nit=f.nit; if(f.email!==undefined) t.email=f.email; if(f.contacto!==undefined) t.contacto=f.contacto; if(f.telefono!==undefined) t.telefono=f.telefono; if(f.vence!==undefined) t.vence=f.vence||null; if(f.fecha_inicio!==undefined) t.fecha_inicio=f.fecha_inicio||null; if(f.fecha_creacion!==undefined) t.fecha_creacion=f.fecha_creacion||null; if(f.plan!==undefined) t.plan=f.plan; if(f.plan_tipo!==undefined) t.plan_tipo=f.plan_tipo; if(f.plan_cost!==undefined) t.plan_cost=Number(f.plan_cost)||0; if(f.logo!==undefined) t.logo=f.logo; if(f.code!==undefined) t.code=(f.code||'').toUpperCase()||null; saveJson(); return t; },
  async deleteTenant(id){ const tid=Number(id); const t=data.tenants.find(x=>x.id===tid); if(!t) return false; const uids=data.users.filter(u=>u.tenant_id===tid).map(u=>u.id); data.sessions=data.sessions.filter(s=>!uids.includes(s.user_id)); data.users=data.users.filter(u=>u.tenant_id!==tid); data.products=data.products.filter(p=>p.tenant_id!==tid); data.sales=data.sales.filter(s=>s.tenant_id!==tid); data.movements=data.movements.filter(m=>m.tenant_id!==tid); data.purchases=data.purchases.filter(p=>p.tenant_id!==tid); data.expenses=data.expenses.filter(e=>e.tenant_id!==tid); data.tenants=data.tenants.filter(x=>x.id!==tid); saveJson(); return true; },
  // Users
  async createUser(o){ const u={ id:nextId('user'), tenant_id:o.tenant_id==null?null:Number(o.tenant_id), branch_id:o.branch_id==null||o.branch_id===''?null:Number(o.branch_id), name:o.name, username:o.username||null, email:o.email||null, role:o.role||'tienda', password_hash:o.password_hash, password_salt:o.password_salt, status:o.status||'activo', last_login:null, created_at:new Date().toISOString() }; data.users.push(u); saveJson(); return u; },
  async getUserById(id){ return data.users.find(u=>u.id===Number(id)) || null; },
  async findUserByUsername(tenantId,username){ const un=String(username||'').trim().toLowerCase(); return data.users.find(u=>(tenantId==null? u.tenant_id==null : u.tenant_id===Number(tenantId)) && (u.username||'').trim().toLowerCase()===un) || null; },
  async listUsers(){ return data.users.map(u=>({ id:u.id, name:u.name, username:u.username, email:u.email||null, role:u.role, tenant_id:u.tenant_id, branch_id:u.branch_id||null, branch_name: u.branch_id?((data.branches.find(b=>b.id===u.branch_id)||{}).name||null):null, status:u.status, last_login:u.last_login||null, tenant_name: u.tenant_id?((data.tenants.find(t=>t.id===u.tenant_id)||{}).name||null):null })); },
  async updateUser(id,f){ const u=data.users.find(x=>x.id===Number(id)); if(!u) return null; if(f.status) u.status=f.status; if(f.name) u.name=f.name; if(f.role) u.role=f.role; if(f.username!==undefined) u.username=f.username; if(f.email!==undefined) u.email=f.email; if(f.branch_id!==undefined) u.branch_id=f.branch_id==null||f.branch_id===''?null:Number(f.branch_id); if(f.last_login!==undefined) u.last_login=f.last_login; if(f.password_hash){ u.password_hash=f.password_hash; u.password_salt=f.password_salt; } saveJson(); return u; },
  async deleteUser(id){ const uid=Number(id); if(!data.users.find(u=>u.id===uid)) return false; data.sessions=data.sessions.filter(s=>s.user_id!==uid); data.users=data.users.filter(u=>u.id!==uid); saveJson(); return true; },
  async setLastLogin(id){ const u=data.users.find(x=>x.id===Number(id)); if(u){ u.last_login=new Date().toISOString(); saveJson(); } },
  // Sessions
  async createSession(token,userId,exp){ data.sessions.push({ token, user_id:userId, expires_at:exp }); saveJson(); },
  async sessionUser(token){ const s=data.sessions.find(x=>x.token===token); if(!s||s.expires_at<Date.now()) return null; return data.users.find(u=>u.id===s.user_id) || null; },
  async deleteSession(token){ data.sessions=data.sessions.filter(s=>s.token!==token); saveJson(); },
  async createReset(token,userId,exp){ data.passwordResets.push({ token, user_id:userId, expires_at:exp }); saveJson(); },
  async resetUser(token){ const r=data.passwordResets.find(x=>x.token===token); if(!r||r.expires_at<Date.now()) return null; return data.users.find(u=>u.id===r.user_id)||null; },
  async deleteReset(token){ data.passwordResets=data.passwordResets.filter(x=>x.token!==token); saveJson(); },
  // Products
  async listProducts(tid){ return data.products.filter(p=>p.tenant_id===tid); },
  async getProduct(id,tid){ return data.products.find(p=>p.id===Number(id)&&p.tenant_id===tid) || null; },
  async createProduct(input,tid){ const now=new Date().toISOString(); const p={ id:nextId('product'), tenant_id:tid, sku:input.sku||'', barcode:input.barcode||'', name:input.name, brand:input.brand||'', category:input.category||'', type:input.type||(input.device?'dispositivo':'accesorio'), emoji:input.emoji||(input.device?'📱':'📦'), price:Number(input.price)||0, cost:Number(input.cost)||0, stock:Number(input.stock)||0, stock_min:Number(input.stock_min)||0, device:input.device?1:0, compat:Array.isArray(input.compat)?input.compat:[], created_at:now, updated_at:now }; data.products.push(p); const bid=jsonDefaultBranchId(tid); data.branchStock.push({ tenant_id:tid, product_id:p.id, branch_id:bid, qty:p.stock }); saveJson(); return p; },
  async updateProduct(id,tid,input){ const p=data.products.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!p) return null; ['sku','barcode','name','brand','category','type','emoji'].forEach(f=>{ if(input[f]!==undefined) p[f]=input[f]; }); ['price','cost','stock','stock_min'].forEach(f=>{ if(input[f]!==undefined) p[f]=Number(input[f])||0; }); if(input.device!==undefined) p.device=input.device?1:0; if(input.compat!==undefined) p.compat=Array.isArray(input.compat)?input.compat:[]; p.updated_at=new Date().toISOString(); saveJson(); return p; },
  async deleteProduct(id,tid){ const i=data.products.findIndex(p=>p.id===Number(id)&&p.tenant_id===tid); if(i<0) return false; data.products.splice(i,1); saveJson(); return true; },
  // Sales
  async listSales(tid){ return data.sales.filter(s=>s.tenant_id===tid); },
  async getSale(id,tid){ return data.sales.find(s=>s.id===Number(id)&&s.tenant_id===tid)||null; },
  async findProductByBarcode(tid,barcode){ const bc=String(barcode||'').trim().toLowerCase(); if(!bc) return null; return data.products.find(p=>p.tenant_id===tid && String(p.barcode||'').trim().toLowerCase()===bc)||null; },
  // Compras / entradas
  async listPurchases(tid){ return data.purchases.filter(p=>p.tenant_id===tid); },
  async markSalePaid(id,tid){ const s=data.sales.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!s) return null; s.pay_status='pagada'; saveJson(); return s; },
  async markPurchasePaid(id,tid){ const p=data.purchases.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!p) return null; p.pay_status='pagada'; saveJson(); return p; },
  // Movimientos / kardex
  async listMovements(tid,productId){ return data.movements.filter(m=>m.tenant_id===tid && (productId?m.product_id===Number(productId):true)).sort((a,b)=>b.id-a.id); },
  // Salidas / ajustes de inventario
  async createAdjustment(input,tid,userId){
    const p=data.products.find(x=>x.id===Number(input.product_id)&&x.tenant_id===tid);
    if(!p) throw { code:'PRODUCTO_NO_EXISTE', message:'El producto no existe' };
    let branchId; if(input.branch_id!=null && input.branch_id!==''){ const b=data.branches.find(x=>x.id===Number(input.branch_id)&&x.tenant_id===tid); if(!b) throw { code:'SUCURSAL_INVALIDA', message:'Sucursal no válida' }; branchId=b.id; } else branchId=jsonDefaultBranchId(tid);
    const row=jsonBranchRow(tid,p.id,branchId); const oldQty=row.qty;
    const type=['salida','merma','traslado','ajuste'].includes(input.type)?input.type:'salida';
    let movQty, newQty;
    if(type==='ajuste'){ newQty=Number(input.qty); if(isNaN(newQty)||newQty<0) throw { code:'CANTIDAD_INVALIDA', message:'Conteo inválido' }; movQty=newQty-oldQty; }
    else { const qn=Number(input.qty)||0; if(qn<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; if(qn>oldQty) throw { code:'STOCK_INSUFICIENTE', message:`Stock insuficiente de ${p.name} en la sucursal (disponible: ${oldQty})` }; newQty=oldQty-qn; movQty=-qn; }
    row.qty=newQty; p.stock=Number(p.stock)+movQty; p.updated_at=new Date().toISOString();
    const mov={ id:nextId('movement'), tenant_id:tid, product_id:p.id, type, qty:movQty, ref:input.motivo||type, branch_id:branchId, created_at:new Date().toISOString() };
    data.movements.push(mov); saveJson();
    return { ...mov, product_name:p.name, newStock:p.stock };
  },
  // Gastos
  async listExpenses(tid){ return data.expenses.filter(e=>e.tenant_id===tid).sort((a,b)=>b.id-a.id); },
  async createExpense(input,tid,userId){ const e={ id:nextId('expense'), tenant_id:tid, user_id:userId, fecha:new Date().toISOString(), categoria:input.categoria||'General', descripcion:input.descripcion||'', monto:Number(input.monto)||0, created_at:new Date().toISOString() }; data.expenses.push(e); saveJson(); return e; },
  async createPurchase(input,tid,userId){
    let branchId; if(input.branch_id!=null && input.branch_id!==''){ const b=data.branches.find(x=>x.id===Number(input.branch_id)&&x.tenant_id===tid); if(!b) throw { code:'SUCURSAL_INVALIDA', message:'Sucursal no válida' }; if(b.status!=='activo') throw { code:'SUCURSAL_INACTIVA', message:'Sucursal inactiva' }; branchId=b.id; } else branchId=jsonDefaultBranchId(tid);
    const agg={};
    for(const it of input.items){ const pid=Number(it.product_id); const qty=Number(it.qty)||0; if(qty<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; const cost=Number(it.cost)||0; if(!agg[pid]) agg[pid]={ qty:0, cost:0 }; agg[pid].qty+=qty; if(cost>0) agg[pid].cost=cost; }
    const lines=[];
    for(const pid of Object.keys(agg)){ const p=data.products.find(x=>x.id===Number(pid)&&x.tenant_id===tid); if(!p) throw { code:'PRODUCTO_NO_EXISTE', message:`El producto ${pid} no existe` }; lines.push({ p, qty:agg[pid].qty, cost:agg[pid].cost }); }
    const id=nextId('purchase'); let total=0; const items=[];
    for(const l of lines){ jsonBranchRow(tid,l.p.id,branchId).qty+=l.qty; l.p.stock+=l.qty; if(l.cost>0) l.p.cost=l.cost; l.p.updated_at=new Date().toISOString(); data.movements.push({ id:nextId('movement'), tenant_id:tid, product_id:l.p.id, type:'entrada', qty:l.qty, ref:'CMP-'+id, branch_id:branchId, created_at:new Date().toISOString() }); const sub=l.cost*l.qty; total+=sub; items.push({ product_id:l.p.id, name:l.p.name, qty:l.qty, cost:l.cost, total:sub }); }
    const purchase={ id, tenant_id:tid, user_id:userId, numero:'E-'+String(id).padStart(5,'0'), fecha:new Date().toISOString(), proveedor:input.proveedor||'Proveedor general', total, branch_id:branchId, pay_status: input.pay_status==='credito'?'credito':'pagada', items, created_at:new Date().toISOString() };
    data.purchases.push(purchase); saveJson(); return purchase;
  },
  async createSale(input,tid,userId){
    let branchId; if(input.branch_id!=null && input.branch_id!==''){ const b=data.branches.find(x=>x.id===Number(input.branch_id)&&x.tenant_id===tid); if(!b) throw { code:'SUCURSAL_INVALIDA', message:'Sucursal no válida' }; if(b.status!=='activo') throw { code:'SUCURSAL_INACTIVA', message:'Sucursal inactiva' }; branchId=b.id; } else branchId=jsonDefaultBranchId(tid);
    const lines=[];
    for(const it of input.items){ const p=data.products.find(x=>x.id===Number(it.product_id)&&x.tenant_id===tid); if(!p) throw { code:'PRODUCTO_NO_EXISTE', message:`El producto ${it.product_id} no existe` }; const qty=Number(it.qty)||0; if(qty<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; const bq=jsonBranchRow(tid,p.id,branchId).qty; if(bq<qty) throw { code:'STOCK_INSUFICIENTE', message:`Stock insuficiente de ${p.name} en la sucursal (disponible: ${bq})` }; lines.push({ p, qty, imeis:(Array.isArray(it.imeis)&&it.imeis.length)?it.imeis.map(x=>String(x).trim()):null }); }
    // Validar IMEIs (si se enviaron) antes de mover stock
    for(const l of lines){ if(l.imeis){ if(l.imeis.length!==l.qty) throw { code:'IMEI_CANTIDAD', message:`La cantidad de IMEI no coincide con ${l.p.name}` }; if(new Set(l.imeis.map(x=>x.toLowerCase())).size!==l.imeis.length) throw { code:'IMEI_DUPLICADO', message:'IMEI repetido en la venta' }; for(const im of l.imeis){ const u=data.units.find(x=>x.tenant_id===tid&&x.product_id===l.p.id&&String(x.imei).trim().toLowerCase()===im.toLowerCase()&&x.status==='disponible'); if(!u) throw { code:'IMEI_INVALIDO', message:`IMEI ${im} no disponible para ${l.p.name}` }; } } }
    // Resolver cliente y validar cupo de crédito ANTES de mover stock
    let customer_id=null, customerName=input.customer||'Consumidor final';
    const credito = input.pay_status==='credito';
    if(input.customer_id!=null && input.customer_id!==''){
      const c=data.customers.find(x=>x.id===Number(input.customer_id)&&x.tenant_id===tid);
      if(!c) throw { code:'CLIENTE_INVALIDO', message:'El cliente no existe' };
      customer_id=c.id; customerName=c.name;
      if(credito && Number(c.credit_limit)>0){
        const bruto0=lines.reduce((a,l)=>a+l.p.price*l.qty,0);
        const saldo=data.sales.filter(s=>s.tenant_id===tid && s.customer_id===c.id && s.pay_status==='credito').reduce((a,s)=>a+s.total,0);
        if(saldo+bruto0 > Number(c.credit_limit)) throw { code:'CUPO_EXCEDIDO', message:`Crédito insuficiente para ${c.name} (cupo: ${c.credit_limit}, saldo actual: ${saldo})` };
      }
    }
    const id=nextId('sale'); let bruto=0; const items=[];
    for(const l of lines){ jsonBranchRow(tid,l.p.id,branchId).qty-=l.qty; l.p.stock-=l.qty; l.p.updated_at=new Date().toISOString(); data.movements.push({ id:nextId('movement'), tenant_id:tid, product_id:l.p.id, type:'venta', qty:-l.qty, ref:'VTA-'+id, branch_id:branchId, created_at:new Date().toISOString() }); const total=l.p.price*l.qty; bruto+=total; const item={ product_id:l.p.id, name:l.p.name, price:l.p.price, qty:l.qty, total }; if(l.imeis){ item.imeis=l.imeis; l.imeis.forEach(im=>{ const u=data.units.find(x=>x.tenant_id===tid&&x.product_id===l.p.id&&String(x.imei).trim().toLowerCase()===im.toLowerCase()&&x.status==='disponible'); if(u){ u.status='vendido'; u.sale_id=id; u.updated_at=new Date().toISOString(); } }); } items.push(item); }
    const base=Math.round(bruto/1.19), iva=bruto-base;
    const csid=(data.cashSessions.find(cs=>cs.tenant_id===tid&&cs.user_id===userId&&cs.status==='abierta')||{}).id||null;
    const sale={ id, tenant_id:tid, user_id:userId, numero:'F-'+String(id).padStart(5,'0'), fecha:new Date().toISOString(), subtotal:base, iva, total:bruto, pay_method:input.pay_method||'efectivo', customer:customerName, customer_id, branch_id:branchId, cash_session_id:csid, pay_status: credito?'credito':'pagada', items, created_at:new Date().toISOString() };
    data.sales.push(sale); saveJson(); return sale;
  },
  // Clientes
  async listCustomers(tid){ return data.customers.filter(c=>c.tenant_id===tid).sort((a,b)=>String(a.name).localeCompare(String(b.name))); },
  async getCustomer(id,tid){ return data.customers.find(c=>c.id===Number(id)&&c.tenant_id===tid)||null; },
  async createCustomer(input,tid){ const c={ id:nextId('customer'), tenant_id:tid, name:String(input.name).trim(), doc:input.doc||'', phone:input.phone||'', email:input.email||'', address:input.address||'', credit_limit:Number(input.credit_limit)||0, notes:input.notes||'', created_at:new Date().toISOString() }; data.customers.push(c); saveJson(); return c; },
  async updateCustomer(id,tid,input){ const c=data.customers.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!c) return null; ['name','doc','phone','email','address','notes'].forEach(f=>{ if(input[f]!==undefined) c[f]=input[f]; }); if(input.credit_limit!==undefined) c.credit_limit=Number(input.credit_limit)||0; saveJson(); return c; },
  async deleteCustomer(id,tid){ const i=data.customers.findIndex(c=>c.id===Number(id)&&c.tenant_id===tid); if(i<0) return false; data.customers.splice(i,1); saveJson(); return true; },
  // Devoluciones / notas crédito
  async listReturns(tid){ return data.returns.filter(r=>r.tenant_id===tid).sort((a,b)=>b.id-a.id); },
  // Unidades serializadas (IMEI / serial)
  async listUnits(tid,productId){ return data.units.filter(u=>u.tenant_id===tid && (productId?u.product_id===Number(productId):true)).sort((a,b)=>b.id-a.id); },
  async findUnitByImei(tid,imei){ const im=String(imei||'').trim().toLowerCase(); return data.units.find(u=>u.tenant_id===tid && String(u.imei).trim().toLowerCase()===im)||null; },
  async createUnit(tid,productId,imei,note){ const im=String(imei||'').trim(); if(!im) throw { code:'VALIDACION', message:'IMEI/serial obligatorio' }; if(data.units.find(u=>u.tenant_id===tid && String(u.imei).trim().toLowerCase()===im.toLowerCase())) throw { code:'IMEI_EXISTE', message:'Ese IMEI/serial ya está registrado' }; const u={ id:nextId('unit'), tenant_id:tid, product_id:Number(productId), imei:im, status:'disponible', sale_id:null, note:note||'', created_at:new Date().toISOString(), updated_at:new Date().toISOString() }; data.units.push(u); saveJson(); return u; },
  async bajaUnit(id,tid){ const u=data.units.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!u) return null; if(u.status==='vendido') throw { code:'UNIDAD_VENDIDA', message:'No puedes dar de baja una unidad vendida' }; u.status='baja'; u.updated_at=new Date().toISOString(); saveJson(); return u; },
  // Sucursales / stock por sucursal
  async listBranches(tid){ const today=new Date().toISOString().slice(0,10); let ch=false; data.branches.forEach(b=>{ if(b.tenant_id===tid && b.vence && today>String(b.vence).slice(0,10) && b.status==='activo'){ b.status='suspendida'; ch=true; } }); if(ch) saveJson(); return data.branches.filter(b=>b.tenant_id===tid).sort((a,b)=>a.id-b.id).map(b=>({ ...b, plan_cost:Number(b.plan_cost)||0, dias_restantes:diasRestantes(b.vence) })); },
  async getBranch(id,tid){ return data.branches.find(b=>b.id===Number(id)&&b.tenant_id===tid)||null; },
  async createBranch(input,tid){ const tipo=input.plan_tipo||null; const ini=input.fecha_inicio||null; const vence=(planMonths(tipo)&&ini)?addMonths(ini,planMonths(tipo)):(input.vence||null); const b={ id:nextId('branch'), tenant_id:tid, name:String(input.name).trim(), address:input.address||'', phone:input.phone||'', status:'activo', fecha_inicio:ini, plan_tipo:tipo, plan_cost:Number(input.plan_cost)||0, vence, created_at:new Date().toISOString() }; data.branches.push(b); saveJson(); return { ...b, dias_restantes:diasRestantes(b.vence) }; },
  async updateBranch(id,tid,input){ const b=data.branches.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!b) return null; ['name','address','phone','status'].forEach(f=>{ if(input[f]!==undefined) b[f]=input[f]; }); if(input.fecha_inicio!==undefined) b.fecha_inicio=input.fecha_inicio||null; if(input.plan_tipo!==undefined) b.plan_tipo=input.plan_tipo||null; if(input.plan_cost!==undefined) b.plan_cost=Number(input.plan_cost)||0; if(input.vence!==undefined) b.vence=input.vence||null; const m=planMonths(b.plan_tipo); if(m && b.fecha_inicio && input.vence===undefined && (input.plan_tipo!==undefined||input.fecha_inicio!==undefined)) b.vence=addMonths(b.fecha_inicio,m); saveJson(); return { ...b, dias_restantes:diasRestantes(b.vence) }; },
  async deleteBranch(id,tid){ const bid=Number(id); if(!data.branches.find(b=>b.id===bid&&b.tenant_id===tid)) return false; const others=data.branches.filter(b=>b.tenant_id===tid && b.id!==bid); if(!others.length) throw { code:'ULTIMA_SUCURSAL', message:'No puedes eliminar la única sucursal' }; if(data.branchStock.some(s=>s.branch_id===bid && s.qty>0)) throw { code:'SUCURSAL_CON_STOCK', message:'La sucursal tiene stock; trasládalo o ajústalo antes de eliminar' }; data.branches=data.branches.filter(b=>b.id!==bid); data.branchStock=data.branchStock.filter(s=>s.branch_id!==bid); saveJson(); return true; },
  async defaultBranchId(tid){ return jsonDefaultBranchId(tid); },
  async productStock(tid,productId){ const pid=Number(productId); return data.branchStock.filter(s=>s.tenant_id===tid && s.product_id===pid).map(s=>({ branch_id:s.branch_id, branch_name:(data.branches.find(b=>b.id===s.branch_id)||{}).name||null, qty:s.qty })); },
  // Caja / turnos
  async listCashSessions(tid,opts={}){ let rows=data.cashSessions.filter(s=>s.tenant_id===tid); if(opts.status) rows=rows.filter(s=>s.status===opts.status); if(opts.user_id!=null) rows=rows.filter(s=>s.user_id===Number(opts.user_id)); return rows.sort((a,b)=>b.id-a.id).slice(0, opts.limit||200); },
  async getCashSession(id,tid){ return data.cashSessions.find(s=>s.id===Number(id)&&s.tenant_id===tid)||null; },
  async currentCashSession(tid,userId){ return data.cashSessions.find(s=>s.tenant_id===tid&&s.user_id===Number(userId)&&s.status==='abierta')||null; },
  async openCashSession(tid,userId,branchId,opening){ if(data.cashSessions.find(s=>s.tenant_id===tid&&s.user_id===Number(userId)&&s.status==='abierta')) throw { code:'CAJA_ABIERTA', message:'Ya tienes una caja abierta' }; let bid; if(branchId!=null&&branchId!==''){ const b=data.branches.find(x=>x.id===Number(branchId)&&x.tenant_id===tid); if(!b) throw { code:'SUCURSAL_INVALIDA', message:'Sucursal no válida' }; bid=b.id; } else bid=jsonDefaultBranchId(tid); const s={ id:nextId('cashsession'), tenant_id:tid, branch_id:bid, user_id:Number(userId), opened_at:new Date().toISOString(), opening_amount:Number(opening)||0, closed_at:null, counted_amount:null, expected_amount:null, difference:null, status:'abierta', notes:'' }; data.cashSessions.push(s); saveJson(); return s; },
  async closeCashSession(id,tid,counted,notes){ const s=data.cashSessions.find(x=>x.id===Number(id)&&x.tenant_id===tid); if(!s) return null; if(s.status!=='abierta') throw { code:'CAJA_CERRADA', message:'La caja ya está cerrada' }; const cashIn=data.sales.filter(v=>v.cash_session_id===s.id && v.pay_method==='efectivo' && v.pay_status!=='credito').reduce((a,v)=>a+v.total,0); const cashOut=data.returns.filter(r=>r.cash_session_id===s.id && r.sale_pay_status!=='credito').reduce((a,r)=>a+r.total,0); const expected=Number(s.opening_amount)+cashIn-cashOut; s.counted_amount=Number(counted)||0; s.expected_amount=expected; s.difference=s.counted_amount-expected; s.closed_at=new Date().toISOString(); s.status='cerrada'; if(notes!==undefined) s.notes=notes||''; saveJson(); return s; },
  async cashSessionSummary(s){ const cashIn=data.sales.filter(v=>v.cash_session_id===s.id && v.pay_method==='efectivo' && v.pay_status!=='credito').reduce((a,v)=>a+v.total,0); const ventas=data.sales.filter(v=>v.cash_session_id===s.id).length; const cashOut=data.returns.filter(r=>r.cash_session_id===s.id && r.sale_pay_status!=='credito').reduce((a,r)=>a+r.total,0); return { cashIn, cashOut, ventas, expected:Number(s.opening_amount)+cashIn-cashOut }; },
  // Facturas de servicio (suscripción)
  async createServiceInvoice(o){ const id=nextId('sinvoice'); const inv={ id, tenant_id:Number(o.tenant_id), branch_id:o.branch_id!=null?Number(o.branch_id):null, numero:'SVC-'+String(id).padStart(5,'0'), plan:o.plan||null, periodo:o.periodo||o.plan||null, amount:Number(o.amount)||0, issued_at: o.issued_at!==undefined ? o.issued_at : new Date().toISOString(), due_date:o.due_date||null, status:o.status||'pendiente', email_to:o.email_to||null, sent:o.sent?1:0, created_at:new Date().toISOString() }; data.serviceInvoices.push(inv); saveJson(); return { ...inv, sent:!!inv.sent }; },
  async listServiceInvoices(tid){ let rows=data.serviceInvoices; if(tid!=null) rows=rows.filter(x=>x.tenant_id===Number(tid)); return rows.slice().sort((a,b)=>b.id-a.id).map(x=>({ ...x, sent:!!x.sent })); },
  async markInvoiceSent(id){ const x=data.serviceInvoices.find(s=>s.id===Number(id)); if(x){ x.sent=1; saveJson(); } },
  async getServiceInvoice(id){ const x=data.serviceInvoices.find(s=>s.id===Number(id)); return x?{ ...x, sent:!!x.sent }:null; },
  async deleteServiceInvoice(id){ const i=data.serviceInvoices.findIndex(s=>s.id===Number(id)); if(i<0) return false; data.serviceInvoices.splice(i,1); saveJson(); return true; },
  async listPendingInvoices(){ return data.serviceInvoices.filter(x=>x.status==='pendiente').sort((a,b)=>b.id-a.id).map(x=>({ ...x, sent:!!x.sent, tenant_name:(data.tenants.find(t=>t.id===x.tenant_id)||{}).name||null, branch_name:(data.branches.find(b=>b.id===x.branch_id)||{}).name||null })); },
  async branchesForBilling(){ return data.branches.filter(b=>b.plan_tipo && b.vence).map(b=>({ id:b.id, tenant_id:b.tenant_id, plan_tipo:b.plan_tipo, plan_cost:Number(b.plan_cost)||0, vence:String(b.vence).slice(0,10), status:b.status, dias_restantes:diasRestantes(b.vence) })); },
  async pendingInvoiceFor(branchId,dueDate){ return data.serviceInvoices.find(x=>x.branch_id===Number(branchId) && x.status==='pendiente' && String(x.due_date).slice(0,10)===String(dueDate).slice(0,10))||null; },
  async markInvoicePaid(id){ const x=data.serviceInvoices.find(s=>s.id===Number(id)); if(!x) return null; x.status='pagada'; x.issued_at=new Date().toISOString(); saveJson(); return { ...x, sent:!!x.sent }; },
  async createReturn(input,tid,userId){
    const sale=data.sales.find(s=>s.id===Number(input.sale_id)&&s.tenant_id===tid);
    if(!sale) throw { code:'VENTA_NO_EXISTE', message:'La venta no existe' };
    if(!Array.isArray(input.items)||!input.items.length) throw { code:'VALIDACION', message:'La devolución no tiene productos' };
    const prev={}; data.returns.filter(r=>r.tenant_id===tid && r.sale_id===sale.id).forEach(r=>(r.items||[]).forEach(it=>{ prev[it.product_id]=(prev[it.product_id]||0)+it.qty; }));
    const lines=[];
    for(const it of input.items){ const pid=Number(it.product_id); const qty=Number(it.qty)||0; if(qty<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; const sold=(sale.items||[]).find(x=>x.product_id===pid); if(!sold) throw { code:'PRODUCTO_NO_EN_VENTA', message:`El producto ${pid} no está en la venta` }; const maxRet=sold.qty-(prev[pid]||0); if(qty>maxRet) throw { code:'CANTIDAD_EXCEDE', message:`No puedes devolver ${qty} de ${sold.name} (máximo ${maxRet})` }; lines.push({ pid, qty, price:sold.price, name:sold.name, imeis:(Array.isArray(it.imeis)&&it.imeis.length)?it.imeis.map(x=>String(x).trim()):null }); }
    for(const l of lines){ if(l.imeis){ if(l.imeis.length!==l.qty) throw { code:'IMEI_CANTIDAD', message:`La cantidad de IMEI no coincide con ${l.name}` }; for(const im of l.imeis){ const u=data.units.find(x=>x.tenant_id===tid&&x.product_id===l.pid&&String(x.imei).trim().toLowerCase()===im.toLowerCase()&&x.status==='vendido'&&x.sale_id===sale.id); if(!u) throw { code:'IMEI_INVALIDO', message:`IMEI ${im} no corresponde a esta venta` }; } } }
    const rbranch=sale.branch_id||jsonDefaultBranchId(tid);
    const id=nextId('return'); let total=0; const items=[];
    for(const l of lines){ const p=data.products.find(x=>x.id===l.pid&&x.tenant_id===tid); if(p){ jsonBranchRow(tid,l.pid,rbranch).qty+=l.qty; p.stock+=l.qty; p.updated_at=new Date().toISOString(); } data.movements.push({ id:nextId('movement'), tenant_id:tid, product_id:l.pid, type:'devolucion', qty:l.qty, ref:'NC-'+id, branch_id:rbranch, created_at:new Date().toISOString() }); if(l.imeis){ l.imeis.forEach(im=>{ const u=data.units.find(x=>x.tenant_id===tid&&x.product_id===l.pid&&String(x.imei).trim().toLowerCase()===im.toLowerCase()&&x.status==='vendido'&&x.sale_id===sale.id); if(u){ u.status='disponible'; u.sale_id=null; u.updated_at=new Date().toISOString(); } }); } const sub=l.price*l.qty; total+=sub; const it2={ product_id:l.pid, name:l.name, price:l.price, qty:l.qty, total:sub }; if(l.imeis) it2.imeis=l.imeis; items.push(it2); }
    const base=Math.round(total/1.19), iva=total-base;
    const csid=(data.cashSessions.find(cs=>cs.tenant_id===tid&&cs.user_id===userId&&cs.status==='abierta')||{}).id||null;
    const ret={ id, tenant_id:tid, user_id:userId, sale_id:sale.id, sale_numero:sale.numero, sale_pay_status:sale.pay_status, numero:'NC-'+String(id).padStart(5,'0'), fecha:new Date().toISOString(), motivo:input.motivo||'', subtotal:base, iva, total, cash_session_id:csid, items, created_at:new Date().toISOString() };
    data.returns.push(ret); saveJson(); return ret;
  },
  async dashboard(tid){
    const today=new Date().toISOString().slice(0,10);
    const ts=data.sales.filter(s=>s.tenant_id===tid && (s.fecha||'').slice(0,10)===today);
    const ventasHoy=ts.reduce((a,s)=>a+s.total,0), baseHoy=ts.reduce((a,s)=>a+s.subtotal,0);
    let costo=0; ts.forEach(s=>s.items.forEach(it=>{ const p=data.products.find(x=>x.id===it.product_id); costo+=(p?p.cost:0)*it.qty; }));
    const low=data.products.filter(p=>p.tenant_id===tid && p.stock<p.stock_min);
    return { ventasHoy, utilidad:baseHoy-costo, ticketPromedio: ts.length?Math.round(ventasHoy/ts.length):0, ventasCount:ts.length, productosCount:data.products.filter(p=>p.tenant_id===tid).length, lowStockCount:low.length };
  }
};

// =======================================================
//  REPOSITORIO POSTGRESQL
// =======================================================
let pool = null;
const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (id SERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT, nit TEXT DEFAULT '', email TEXT, contacto TEXT, telefono TEXT, vence DATE, logo TEXT, status TEXT DEFAULT 'activo', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, username TEXT, email TEXT, role TEXT NOT NULL DEFAULT 'tienda', password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, status TEXT DEFAULT 'activo', last_login TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, sku TEXT DEFAULT '', barcode TEXT DEFAULT '', name TEXT NOT NULL, brand TEXT DEFAULT '', category TEXT DEFAULT '', type TEXT DEFAULT '', emoji TEXT DEFAULT '', price NUMERIC DEFAULT 0, cost NUMERIC DEFAULT 0, stock INTEGER DEFAULT 0, stock_min INTEGER DEFAULT 0, device INTEGER DEFAULT 0, compat JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sales (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, user_id INTEGER, numero TEXT, fecha TIMESTAMPTZ DEFAULT now(), subtotal NUMERIC, iva NUMERIC, total NUMERIC, pay_method TEXT, customer TEXT, customer_id INTEGER, pay_status TEXT DEFAULT 'pagada', items JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, doc TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', credit_limit NUMERIC DEFAULT 0, notes TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS returns (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, user_id INTEGER, sale_id INTEGER, sale_numero TEXT, sale_pay_status TEXT, numero TEXT, fecha TIMESTAMPTZ DEFAULT now(), motivo TEXT DEFAULT '', subtotal NUMERIC, iva NUMERIC, total NUMERIC, items JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS units (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, product_id INTEGER, imei TEXT NOT NULL, status TEXT DEFAULT 'disponible', sale_id INTEGER, note TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS branches (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, address TEXT DEFAULT '', phone TEXT DEFAULT '', status TEXT DEFAULT 'activo', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS branch_stock (tenant_id INTEGER, product_id INTEGER, branch_id INTEGER, qty INTEGER DEFAULT 0, PRIMARY KEY(product_id, branch_id))`,
  `CREATE TABLE IF NOT EXISTS cash_sessions (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, branch_id INTEGER, user_id INTEGER, opened_at TIMESTAMPTZ DEFAULT now(), opening_amount NUMERIC DEFAULT 0, closed_at TIMESTAMPTZ, counted_amount NUMERIC, expected_amount NUMERIC, difference NUMERIC, status TEXT DEFAULT 'abierta', notes TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS password_resets (token TEXT PRIMARY KEY, user_id INTEGER, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS service_invoices (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, numero TEXT, plan TEXT, amount NUMERIC DEFAULT 0, issued_at TIMESTAMPTZ DEFAULT now(), due_date DATE, status TEXT DEFAULT 'activo', email_to TEXT, sent INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS movements (id SERIAL PRIMARY KEY, tenant_id INTEGER, product_id INTEGER, type TEXT, qty INTEGER, ref TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS purchases (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, user_id INTEGER, numero TEXT, fecha TIMESTAMPTZ DEFAULT now(), proveedor TEXT, total NUMERIC, pay_status TEXT DEFAULT 'pagada', items JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS expenses (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, user_id INTEGER, fecha TIMESTAMPTZ DEFAULT now(), categoria TEXT, descripcion TEXT, monto NUMERIC, created_at TIMESTAMPTZ DEFAULT now())`,
  // Auditoría: sin FK ni RLS (debe sobrevivir al borrado de empresa y registrar acciones de súper-admin)
  `CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), actor_user_id INTEGER, actor_name TEXT, actor_role TEXT, tenant_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT, ip TEXT)`
];
// Migraciones suaves para bases ya existentes (no afectan datos)
const MIGRATIONS = [
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS pay_status TEXT DEFAULT 'pagada'`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS pay_status TEXT DEFAULT 'pagada'`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS code TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`,
  `ALTER TABLE users ALTER COLUMN email DROP NOT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contacto TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS telefono TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vence DATE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INTEGER`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS branch_id INTEGER`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS branch_id INTEGER`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS branch_id INTEGER`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_session_id INTEGER`,
  `ALTER TABLE returns ADD COLUMN IF NOT EXISTS cash_session_id INTEGER`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_cost NUMERIC DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_tipo TEXT`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fecha_inicio DATE`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fecha_creacion DATE`,
  `ALTER TABLE branches ADD COLUMN IF NOT EXISTS fecha_inicio DATE`,
  `ALTER TABLE branches ADD COLUMN IF NOT EXISTS plan_tipo TEXT`,
  `ALTER TABLE branches ADD COLUMN IF NOT EXISTS plan_cost NUMERIC DEFAULT 0`,
  `ALTER TABLE branches ADD COLUMN IF NOT EXISTS vence DATE`,
  `ALTER TABLE service_invoices ADD COLUMN IF NOT EXISTS branch_id INTEGER`,
  `ALTER TABLE service_invoices ADD COLUMN IF NOT EXISTS periodo TEXT`
];
// Índices y restricciones (se aplican con try/catch: los UNIQUE pueden fallar sobre datos sucios preexistentes)
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_tenant ON purchases(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON expenses(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_movements_tenant_prod ON movements(tenant_id, product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_tenant_id ON audit_log(tenant_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(tenant_id, customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_returns_tenant ON returns(tenant_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id)`,
  `CREATE INDEX IF NOT EXISTS idx_units_product ON units(tenant_id, product_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_units_imei ON units(tenant_id, lower(btrim(imei)))`,
  `CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_branch_stock_tenant ON branch_stock(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_branch_stock_branch ON branch_stock(branch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_sessions_tenant ON cash_sessions(tenant_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_sessions_open ON cash_sessions(tenant_id, user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_cash ON sales(cash_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sinvoices_tenant ON service_invoices(tenant_id, id DESC)`,
  // Unicidad de usuario por empresa (case-insensitive). tenant_id NULL (súper-admin) agrupado como 0.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_username ON users(COALESCE(tenant_id,0), lower(btrim(username))) WHERE username IS NOT NULL`,
  // Unicidad de nombre de empresa (case-insensitive)
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_name ON tenants(lower(btrim(name)))`
];
const iso = v => (v instanceof Date ? v.toISOString() : v);
function mapTenant(r){ return { id:r.id, name:r.name, code:r.code||null, nit:r.nit, email:r.email||null, contacto:r.contacto||null, telefono:r.telefono||null, vence: r.vence? (r.vence instanceof Date? r.vence.toISOString().slice(0,10) : String(r.vence).slice(0,10)) : null, fecha_inicio: r.fecha_inicio? (r.fecha_inicio instanceof Date? r.fecha_inicio.toISOString().slice(0,10) : String(r.fecha_inicio).slice(0,10)) : null, fecha_creacion: r.fecha_creacion? (r.fecha_creacion instanceof Date? r.fecha_creacion.toISOString().slice(0,10) : String(r.fecha_creacion).slice(0,10)) : null, plan:r.plan||null, plan_tipo:r.plan_tipo||null, plan_cost:Number(r.plan_cost)||0, logo:r.logo||null, status:r.status, dias_restantes:diasRestantes(r.vence), created_at:iso(r.created_at) }; }
function diasRestantes(vence){ if(!vence) return null; const d=String(vence instanceof Date?vence.toISOString():vence).slice(0,10); const v=new Date(d+'T00:00:00'); const t=new Date(); t.setHours(0,0,0,0); return Math.round((v-t)/86400000); }
function planMonths(tipo){ return ({ mensual:1, trimestral:3, semestral:6, anual:12 })[String(tipo||'').toLowerCase()] || 0; }
function addMonths(dateStr, months){ const d=new Date(String(dateStr).slice(0,10)+'T00:00:00'); if(isNaN(d.getTime())) return null; const day=d.getDate(); d.setMonth(d.getMonth()+months); if(d.getDate()<day) d.setDate(0); return d.toISOString().slice(0,10); }
// Calcula la fecha de vencimiento a partir de fecha_inicio + tipo de plan (meses calendario)
function computeVence(b){ const m=planMonths(b&&b.plan_tipo); if(m>0 && b && b.fecha_inicio) return addMonths(b.fecha_inicio, m); return undefined; }
function mapServiceInvoice(r){ return { id:r.id, tenant_id:r.tenant_id, branch_id:r.branch_id!=null?Number(r.branch_id):null, numero:r.numero, plan:r.plan||null, periodo:r.periodo||r.plan||null, amount:Number(r.amount)||0, issued_at:r.issued_at?iso(r.issued_at):null, due_date: r.due_date? (r.due_date instanceof Date? r.due_date.toISOString().slice(0,10): String(r.due_date).slice(0,10)) : null, status:r.status||'pendiente', email_to:r.email_to||null, sent:!!r.sent, created_at:iso(r.created_at) }; }
function mapProduct(r){ return { id:r.id, tenant_id:r.tenant_id, sku:r.sku, barcode:r.barcode, name:r.name, brand:r.brand, category:r.category, type:r.type, emoji:r.emoji, price:Number(r.price), cost:Number(r.cost), stock:Number(r.stock), stock_min:Number(r.stock_min), device:Number(r.device), compat: Array.isArray(r.compat)?r.compat:(r.compat||[]), created_at:iso(r.created_at), updated_at:iso(r.updated_at) }; }
function mapSale(r){ return { id:r.id, tenant_id:r.tenant_id, user_id:r.user_id, numero:r.numero, fecha:iso(r.fecha), subtotal:Number(r.subtotal), iva:Number(r.iva), total:Number(r.total), pay_method:r.pay_method, customer:r.customer, customer_id: r.customer_id!=null?Number(r.customer_id):null, branch_id: r.branch_id!=null?Number(r.branch_id):null, cash_session_id: r.cash_session_id!=null?Number(r.cash_session_id):null, pay_status:r.pay_status||'pagada', items: r.items||[], created_at:iso(r.created_at) }; }
function mapPurchase(r){ return { id:r.id, tenant_id:r.tenant_id, user_id:r.user_id, numero:r.numero, fecha:iso(r.fecha), proveedor:r.proveedor, total:Number(r.total), pay_status:r.pay_status||'pagada', branch_id: r.branch_id!=null?Number(r.branch_id):null, items: r.items||[], created_at:iso(r.created_at) }; }
function mapExpense(r){ return { id:r.id, tenant_id:r.tenant_id, user_id:r.user_id, fecha:iso(r.fecha), categoria:r.categoria, descripcion:r.descripcion, monto:Number(r.monto), created_at:iso(r.created_at) }; }
function mapMovement(r){ return { id:r.id, tenant_id:r.tenant_id, product_id:r.product_id, type:r.type, qty:Number(r.qty), ref:r.ref, branch_id: r.branch_id!=null?Number(r.branch_id):null, created_at:iso(r.created_at) }; }
function mapBranch(r){ return { id:r.id, tenant_id:r.tenant_id, name:r.name, address:r.address||'', phone:r.phone||'', status:r.status||'activo', fecha_inicio: r.fecha_inicio? (r.fecha_inicio instanceof Date? r.fecha_inicio.toISOString().slice(0,10): String(r.fecha_inicio).slice(0,10)) : null, plan_tipo:r.plan_tipo||null, plan_cost:Number(r.plan_cost)||0, vence: r.vence? (r.vence instanceof Date? r.vence.toISOString().slice(0,10): String(r.vence).slice(0,10)) : null, dias_restantes:diasRestantes(r.vence), created_at:iso(r.created_at) }; }
function mapCustomer(r){ return { id:r.id, tenant_id:r.tenant_id, name:r.name, doc:r.doc||'', phone:r.phone||'', email:r.email||'', address:r.address||'', credit_limit:Number(r.credit_limit)||0, notes:r.notes||'', created_at:iso(r.created_at) }; }
function mapReturn(r){ return { id:r.id, tenant_id:r.tenant_id, user_id:r.user_id, sale_id:r.sale_id, sale_numero:r.sale_numero, sale_pay_status:r.sale_pay_status, numero:r.numero, fecha:iso(r.fecha), motivo:r.motivo||'', subtotal:Number(r.subtotal), iva:Number(r.iva), total:Number(r.total), cash_session_id: r.cash_session_id!=null?Number(r.cash_session_id):null, items:r.items||[], created_at:iso(r.created_at) }; }
function mapCashSession(r){ return { id:r.id, tenant_id:r.tenant_id, branch_id:r.branch_id, user_id:r.user_id, opened_at:iso(r.opened_at), opening_amount:Number(r.opening_amount)||0, closed_at: r.closed_at?iso(r.closed_at):null, counted_amount: r.counted_amount!=null?Number(r.counted_amount):null, expected_amount: r.expected_amount!=null?Number(r.expected_amount):null, difference: r.difference!=null?Number(r.difference):null, status:r.status||'abierta', notes:r.notes||'' }; }
function mapUnit(r){ return { id:r.id, tenant_id:r.tenant_id, product_id:r.product_id, imei:r.imei, status:r.status, sale_id:r.sale_id!=null?Number(r.sale_id):null, note:r.note||'', created_at:iso(r.created_at), updated_at:iso(r.updated_at) }; }
// Ejecuta una consulta aplicando el contexto RLS de la petición actual.
// - Dentro de una transacción explícita (o el arranque): usa el cliente fijado en `als`.
// - Con RLS activa y sin cliente fijo: toma una conexión del pool SOLO durante la consulta,
//   envuelta en una micro-transacción con SET LOCAL (no se retiene conexión por petición).
// - Sin RLS: consulta directa al pool.
async function q(text, params){
  const st = als.getStore();
  if(st && st.client) return st.client.query(text, params);
  if(!RLS_ON) return pool.query(text, params);
  const tid = st && st.tid!=null ? String(st.tid) : '';
  const sup = st && st.sup ? 'on' : 'off';
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.super',$2,true)",[tid,sup]);
    const r = await client.query(text, params);
    await client.query('COMMIT');
    return r;
  }catch(e){ try{ await client.query('ROLLBACK'); }catch(_){ } throw e; }
  finally{ client.release(); }
}
const pgRepo = {
  async countUsers(){ const r=await q('SELECT COUNT(*) AS c FROM users'); return Number(r.rows[0].c); },
  // Auditoría
  async logAudit(e){ const r=await q(`INSERT INTO audit_log(actor_user_id,actor_name,actor_role,tenant_id,action,entity,entity_id,detail,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[e.actor_user_id==null?null:Number(e.actor_user_id),e.actor_name||null,e.actor_role||null,e.tenant_id==null?null:Number(e.tenant_id),e.action,e.entity||null,e.entity_id==null?null:Number(e.entity_id),e.detail||null,e.ip||null]); return r.rows[0]; },
  async listAudit({ tenant_id=null, limit=200 }={}){ const lim=Math.max(1,Number(limit)||200); let r; if(tenant_id!=null) r=await q('SELECT * FROM audit_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2',[Number(tenant_id),lim]); else r=await q('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1',[lim]); return r.rows.map(x=>({ ...x, ts: x.ts instanceof Date? x.ts.toISOString(): x.ts })); },
  // Tenants
  async createTenant(o){ const r=await q(`INSERT INTO tenants(name,code,nit,email,contacto,telefono,vence,fecha_inicio,fecha_creacion,plan,plan_tipo,plan_cost,logo) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[o.name,(o.code||'').toUpperCase()||null,o.nit||'',o.email||null,o.contacto||null,o.telefono||null,o.vence||null,o.fecha_inicio||null,o.fecha_creacion||null,o.plan||null,o.plan_tipo||null,Number(o.plan_cost)||0,o.logo||null]); const t=mapTenant(r.rows[0]); await q(`INSERT INTO branches(tenant_id,name) VALUES($1,'Principal')`,[t.id]); return t; },
  async getTenant(id){ const r=await q('SELECT * FROM tenants WHERE id=$1',[Number(id)]); return r.rows[0]?mapTenant(r.rows[0]):null; },
  async findTenantByCode(code){ const r=await q('SELECT * FROM tenants WHERE upper(code)=upper($1) LIMIT 1',[String(code||'')]); return r.rows[0]?mapTenant(r.rows[0]):null; },
  async findTenantByName(name){ const r=await q('SELECT * FROM tenants WHERE lower(btrim(name))=lower(btrim($1)) LIMIT 1',[String(name||'')]); return r.rows[0]?mapTenant(r.rows[0]):null; },
  async listTenants(){ try{ await q("UPDATE tenants SET status='inactivo' WHERE status='activo' AND vence IS NOT NULL AND vence < CURRENT_DATE"); }catch(e){} const t=await q('SELECT * FROM tenants ORDER BY id'); const uc=await q('SELECT tenant_id, COUNT(*) AS c FROM users WHERE tenant_id IS NOT NULL GROUP BY tenant_id'); const pc=await q('SELECT tenant_id, COUNT(*) AS c FROM products GROUP BY tenant_id'); const um={},pm={}; uc.rows.forEach(r=>{ um[r.tenant_id]=Number(r.c); }); pc.rows.forEach(r=>{ pm[r.tenant_id]=Number(r.c); }); return t.rows.map(x=>({ ...mapTenant(x), users:um[x.id]||0, products:pm[x.id]||0 })); },
  async updateTenant(id,f){ const sets=[],vals=[]; let i=1; const fx={...f}; if(fx.code!==undefined) fx.code=(fx.code||'').toUpperCase()||null; if(fx.vence!==undefined) fx.vence=fx.vence||null; ['status','name','nit','email','contacto','telefono','vence','fecha_inicio','fecha_creacion','plan','plan_tipo','plan_cost','logo','code'].forEach(k=>{ if(fx[k]!==undefined){ sets.push(`${k}=$${i++}`); vals.push(fx[k]); } }); if(!sets.length) return this.getTenant(id); vals.push(Number(id)); const r=await q(`UPDATE tenants SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,vals); return r.rows[0]?mapTenant(r.rows[0]):null; },
  async deleteTenant(id){ const r=await q('DELETE FROM tenants WHERE id=$1',[Number(id)]); return r.rowCount>0; },
  // Users
  async createUser(o){ const r=await q(`INSERT INTO users(tenant_id,branch_id,name,username,email,role,password_hash,password_salt,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[o.tenant_id==null?null:Number(o.tenant_id),(o.branch_id==null||o.branch_id==='')?null:Number(o.branch_id),o.name,o.username||null,o.email||null,o.role||'tienda',o.password_hash,o.password_salt,o.status||'activo']); return r.rows[0]; },
  async getUserById(id){ const r=await q('SELECT * FROM users WHERE id=$1',[Number(id)]); return r.rows[0]||null; },
  async findUserByUsername(tenantId,username){ const un=String(username||''); const r=(tenantId==null)?await q('SELECT * FROM users WHERE tenant_id IS NULL AND lower(btrim(username))=lower(btrim($1)) LIMIT 1',[un]):await q('SELECT * FROM users WHERE tenant_id=$1 AND lower(btrim(username))=lower(btrim($2)) LIMIT 1',[Number(tenantId),un]); return r.rows[0]||null; },
  async listUsers(){ const r=await q(`SELECT u.id,u.name,u.username,u.email,u.role,u.tenant_id,u.branch_id,u.status,u.last_login, t.name AS tenant_name, b.name AS branch_name FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id LEFT JOIN branches b ON b.id=u.branch_id ORDER BY u.id`); return r.rows.map(u=>({ ...u, last_login: u.last_login? iso(u.last_login): null })); },
  async updateUser(id,f){ const sets=[],vals=[]; let i=1; ['status','name','role','username','email','branch_id','last_login','password_hash','password_salt'].forEach(k=>{ if(f[k]!==undefined){ sets.push(`${k}=$${i++}`); vals.push(f[k]); } }); if(!sets.length) return this.getUserById(id); vals.push(Number(id)); const r=await q(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,vals); return r.rows[0]||null; },
  async deleteUser(id){ const r=await q('DELETE FROM users WHERE id=$1',[Number(id)]); return r.rowCount>0; },
  async setLastLogin(id){ await q('UPDATE users SET last_login=now() WHERE id=$1',[Number(id)]); },
  // Sessions
  async createSession(token,userId,exp){ await q('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,$3)',[token,userId,exp]); },
  async sessionUser(token){ const r=await q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>$2',[token,Date.now()]); return r.rows[0]||null; },
  async deleteSession(token){ await q('DELETE FROM sessions WHERE token=$1',[token]); },
  async createReset(token,userId,exp){ await q('INSERT INTO password_resets(token,user_id,expires_at) VALUES($1,$2,$3)',[token,userId,exp]); },
  async resetUser(token){ const r=await q('SELECT u.* FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token=$1 AND pr.expires_at>$2',[token,Date.now()]); return r.rows[0]||null; },
  async deleteReset(token){ await q('DELETE FROM password_resets WHERE token=$1',[token]); },
  // Products
  async listProducts(tid){ const r=await q('SELECT * FROM products WHERE tenant_id=$1 ORDER BY id',[tid]); return r.rows.map(mapProduct); },
  async getProduct(id,tid){ const r=await q('SELECT * FROM products WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rows[0]?mapProduct(r.rows[0]):null; },
  async createProduct(input,tid){ const r=await q(`INSERT INTO products(tenant_id,sku,barcode,name,brand,category,type,emoji,price,cost,stock,stock_min,device,compat) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,[tid,input.sku||'',input.barcode||'',input.name,input.brand||'',input.category||'',input.type||(input.device?'dispositivo':'accesorio'),input.emoji||(input.device?'📱':'📦'),Number(input.price)||0,Number(input.cost)||0,Number(input.stock)||0,Number(input.stock_min)||0,input.device?1:0,JSON.stringify(Array.isArray(input.compat)?input.compat:[])]); const p=mapProduct(r.rows[0]); const bid=await this.defaultBranchId(tid); await q('INSERT INTO branch_stock(tenant_id,product_id,branch_id,qty) VALUES($1,$2,$3,$4) ON CONFLICT (product_id,branch_id) DO NOTHING',[tid,p.id,bid,p.stock]); return p; },
  async updateProduct(id,tid,input){ const sets=[],vals=[]; let i=1; ['sku','barcode','name','brand','category','type','emoji'].forEach(k=>{ if(input[k]!==undefined){ sets.push(`${k}=$${i++}`); vals.push(input[k]); } }); ['price','cost','stock','stock_min'].forEach(k=>{ if(input[k]!==undefined){ sets.push(`${k}=$${i++}`); vals.push(Number(input[k])||0); } }); if(input.device!==undefined){ sets.push(`device=$${i++}`); vals.push(input.device?1:0); } if(input.compat!==undefined){ sets.push(`compat=$${i++}::jsonb`); vals.push(JSON.stringify(Array.isArray(input.compat)?input.compat:[])); } sets.push('updated_at=now()'); vals.push(Number(id)); vals.push(tid); const r=await q(`UPDATE products SET ${sets.join(',')} WHERE id=$${i++} AND tenant_id=$${i} RETURNING *`,vals); return r.rows[0]?mapProduct(r.rows[0]):null; },
  async deleteProduct(id,tid){ const r=await q('DELETE FROM products WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rowCount>0; },
  // Sales
  async listSales(tid){ const r=await q('SELECT * FROM sales WHERE tenant_id=$1 ORDER BY id DESC',[tid]); return r.rows.map(mapSale); },
  async getSale(id,tid){ const r=await q('SELECT * FROM sales WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rows[0]?mapSale(r.rows[0]):null; },
  async findProductByBarcode(tid,barcode){ const bc=String(barcode||'').trim(); if(!bc) return null; const r=await q("SELECT * FROM products WHERE tenant_id=$1 AND barcode<>'' AND lower(btrim(barcode))=lower(btrim($2)) LIMIT 1",[tid,bc]); return r.rows[0]?mapProduct(r.rows[0]):null; },
  // Compras / entradas
  async listPurchases(tid){ const r=await q('SELECT * FROM purchases WHERE tenant_id=$1 ORDER BY id DESC',[tid]); return r.rows.map(mapPurchase); },
  async markSalePaid(id,tid){ const r=await q(`UPDATE sales SET pay_status='pagada' WHERE id=$1 AND tenant_id=$2 RETURNING *`,[Number(id),tid]); return r.rows[0]?mapSale(r.rows[0]):null; },
  async markPurchasePaid(id,tid){ const r=await q(`UPDATE purchases SET pay_status='pagada' WHERE id=$1 AND tenant_id=$2 RETURNING *`,[Number(id),tid]); return r.rows[0]?mapPurchase(r.rows[0]):null; },
  async listMovements(tid,productId){ let r; if(productId) r=await q('SELECT * FROM movements WHERE tenant_id=$1 AND product_id=$2 ORDER BY id DESC',[tid,Number(productId)]); else r=await q('SELECT * FROM movements WHERE tenant_id=$1 ORDER BY id DESC',[tid]); return r.rows.map(mapMovement); },
  async createAdjustment(input,tid,userId){
    const client=await pool.connect();
    try{
      await client.query('BEGIN'); await setLocalCtx(client, tid);
      const r=await client.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[Number(input.product_id),tid]);
      const p=r.rows[0];
      if(!p) throw { code:'PRODUCTO_NO_EXISTE', message:'El producto no existe' };
      const branchId=await pgResolveBranch(client,tid,input.branch_id);
      const oldQty=await pgBranchQty(client,tid,Number(p.id),branchId);
      const type=['salida','merma','traslado','ajuste'].includes(input.type)?input.type:'salida';
      let movQty, newQty;
      if(type==='ajuste'){ newQty=Number(input.qty); if(isNaN(newQty)||newQty<0) throw { code:'CANTIDAD_INVALIDA', message:'Conteo inválido' }; movQty=newQty-oldQty; }
      else { const qn=Number(input.qty)||0; if(qn<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; if(qn>oldQty) throw { code:'STOCK_INSUFICIENTE', message:`Stock insuficiente de ${p.name} en la sucursal (disponible: ${oldQty})` }; newQty=oldQty-qn; movQty=-qn; }
      const newStock=Number(p.stock)+movQty;
      await client.query('UPDATE branch_stock SET qty=$1 WHERE product_id=$2 AND branch_id=$3',[newQty,p.id,branchId]);
      await client.query('UPDATE products SET stock=$1, updated_at=now() WHERE id=$2',[newStock,p.id]);
      const mv=await client.query('INSERT INTO movements(tenant_id,product_id,type,qty,ref,branch_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[tid,p.id,type,movQty,input.motivo||type,branchId]);
      await client.query('COMMIT');
      return { ...mapMovement(mv.rows[0]), product_name:p.name, newStock };
    }catch(e){ await client.query('ROLLBACK'); throw e; }
    finally{ client.release(); }
  },
  async listExpenses(tid){ const r=await q('SELECT * FROM expenses WHERE tenant_id=$1 ORDER BY id DESC',[tid]); return r.rows.map(mapExpense); },
  async createExpense(input,tid,userId){ const r=await q(`INSERT INTO expenses(tenant_id,user_id,categoria,descripcion,monto) VALUES($1,$2,$3,$4,$5) RETURNING *`,[tid,userId,input.categoria||'General',input.descripcion||'',Number(input.monto)||0]); return mapExpense(r.rows[0]); },
  async createPurchase(input,tid,userId){
    const client=await pool.connect();
    try{
      await client.query('BEGIN'); await setLocalCtx(client, tid);
      const agg={};
      for(const it of input.items){ const pid=Number(it.product_id); const qty=Number(it.qty)||0; if(qty<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; const cost=Number(it.cost)||0; if(!agg[pid]) agg[pid]={ qty:0, cost:0 }; agg[pid].qty+=qty; if(cost>0) agg[pid].cost=cost; }
      const lines=[];
      for(const pid of Object.keys(agg)){ const r=await client.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[Number(pid),tid]); const p=r.rows[0]; if(!p) throw { code:'PRODUCTO_NO_EXISTE', message:`El producto ${pid} no existe` }; lines.push({ p, qty:agg[pid].qty, cost:agg[pid].cost }); }
      let total=0; const items=[];
      for(const l of lines){ const sub=l.cost*l.qty; total+=sub; items.push({ product_id:l.p.id, name:l.p.name, qty:l.qty, cost:l.cost, total:sub }); }
      const branchId=await pgResolveBranch(client,tid,input.branch_id);
      const ins=await client.query(`INSERT INTO purchases(tenant_id,user_id,numero,proveedor,total,pay_status,items,branch_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[tid,userId,'TMP',input.proveedor||'Proveedor general',total,input.pay_status==='credito'?'credito':'pagada',JSON.stringify(items),branchId]);
      const purchase=ins.rows[0];
      const numero='E-'+String(purchase.id).padStart(5,'0');
      await client.query('UPDATE purchases SET numero=$1 WHERE id=$2',[numero,purchase.id]);
      for(const l of lines){
        const newStock=Number(l.p.stock)+l.qty;
        if(l.cost>0) await client.query('UPDATE products SET stock=$1, cost=$2, updated_at=now() WHERE id=$3',[newStock,l.cost,l.p.id]);
        else await client.query('UPDATE products SET stock=$1, updated_at=now() WHERE id=$2',[newStock,l.p.id]);
        await client.query('INSERT INTO branch_stock(tenant_id,product_id,branch_id,qty) VALUES($1,$2,$3,$4) ON CONFLICT (product_id,branch_id) DO UPDATE SET qty=branch_stock.qty+EXCLUDED.qty',[tid,l.p.id,branchId,l.qty]);
        await client.query('INSERT INTO movements(tenant_id,product_id,type,qty,ref,branch_id) VALUES($1,$2,$3,$4,$5,$6)',[tid,l.p.id,'entrada',l.qty,'CMP-'+purchase.id,branchId]);
      }
      await client.query('COMMIT');
      purchase.numero=numero;
      return mapPurchase(purchase);
    }catch(e){ await client.query('ROLLBACK'); throw e; }
    finally{ client.release(); }
  },
  async createSale(input,tid,userId){
    const client=await pool.connect();
    try{
      await client.query('BEGIN'); await setLocalCtx(client, tid);
      const branchId=await pgResolveBranch(client,tid,input.branch_id);
      const agg={}; const imeisByPid={};
      for(const it of input.items){ const pid=Number(it.product_id); const qty=Number(it.qty)||0; if(qty<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; agg[pid]=(agg[pid]||0)+qty; if(Array.isArray(it.imeis)&&it.imeis.length) imeisByPid[pid]=(imeisByPid[pid]||[]).concat(it.imeis.map(x=>String(x).trim())); }
      const lines=[];
      for(const pid of Object.keys(agg)){
        const qty=agg[pid];
        const r=await client.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[Number(pid),tid]);
        const p=r.rows[0];
        if(!p) throw { code:'PRODUCTO_NO_EXISTE', message:`El producto ${pid} no existe` };
        const bq=await pgBranchQty(client,tid,Number(pid),branchId); if(bq<qty) throw { code:'STOCK_INSUFICIENTE', message:`Stock insuficiente de ${p.name} en la sucursal (disponible: ${bq})` };
        lines.push({ p, qty });
      }
      let bruto=0; const items=[];
      for(const l of lines){ const total=Number(l.p.price)*l.qty; bruto+=total; const it={ product_id:l.p.id, name:l.p.name, price:Number(l.p.price), qty:l.qty, total }; if(imeisByPid[l.p.id]&&imeisByPid[l.p.id].length) it.imeis=imeisByPid[l.p.id]; items.push(it); }
      const base=Math.round(bruto/1.19), iva=bruto-base;
      let customer_id=null, customerName=input.customer||'Consumidor final';
      if(input.customer_id!=null && input.customer_id!==''){
        const cr=await client.query('SELECT * FROM customers WHERE id=$1 AND tenant_id=$2',[Number(input.customer_id),tid]);
        const c=cr.rows[0];
        if(!c) throw { code:'CLIENTE_INVALIDO', message:'El cliente no existe' };
        customer_id=c.id; customerName=c.name;
        if(input.pay_status==='credito' && Number(c.credit_limit)>0){
          const sb=await client.query("SELECT COALESCE(SUM(total),0) AS s FROM sales WHERE tenant_id=$1 AND customer_id=$2 AND pay_status='credito'",[tid,c.id]);
          if(Number(sb.rows[0].s)+bruto > Number(c.credit_limit)) throw { code:'CUPO_EXCEDIDO', message:`Crédito insuficiente para ${c.name} (cupo: ${c.credit_limit}, saldo actual: ${Number(sb.rows[0].s)})` };
        }
      }
      const csr=await client.query("SELECT id FROM cash_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='abierta' LIMIT 1",[tid,userId]); const csid=csr.rows[0]?csr.rows[0].id:null;
      const ins=await client.query(`INSERT INTO sales(tenant_id,user_id,numero,subtotal,iva,total,pay_method,customer,customer_id,branch_id,cash_session_id,pay_status,items) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,[tid,userId,'TMP',base,iva,bruto,input.pay_method||'efectivo',customerName,customer_id,branchId,csid,input.pay_status==='credito'?'credito':'pagada',JSON.stringify(items)]);
      const sale=ins.rows[0];
      const numero='F-'+String(sale.id).padStart(5,'0');
      await client.query('UPDATE sales SET numero=$1 WHERE id=$2',[numero,sale.id]);
      for(const l of lines){
        await client.query('UPDATE products SET stock = $1, updated_at=now() WHERE id=$2',[Number(l.p.stock)-l.qty, l.p.id]);
        await client.query('UPDATE branch_stock SET qty=qty-$1 WHERE product_id=$2 AND branch_id=$3',[l.qty,l.p.id,branchId]);
        await client.query('INSERT INTO movements(tenant_id,product_id,type,qty,ref,branch_id) VALUES($1,$2,$3,$4,$5,$6)',[tid,l.p.id,'venta',-l.qty,'VTA-'+sale.id,branchId]);
      }
      for(const pid of Object.keys(imeisByPid)){ const ims=imeisByPid[pid]; if(ims.length!==agg[pid]) throw { code:'IMEI_CANTIDAD', message:'La cantidad de IMEI no coincide' }; if(new Set(ims.map(x=>x.toLowerCase())).size!==ims.length) throw { code:'IMEI_DUPLICADO', message:'IMEI repetido en la venta' }; for(const im of ims){ const ur=await client.query("UPDATE units SET status='vendido', sale_id=$1, updated_at=now() WHERE tenant_id=$2 AND product_id=$3 AND lower(btrim(imei))=lower(btrim($4)) AND status='disponible' RETURNING id",[sale.id,tid,Number(pid),im]); if(!ur.rowCount) throw { code:'IMEI_INVALIDO', message:`IMEI ${im} no disponible` }; } }
      await client.query('COMMIT');
      sale.numero=numero;
      return mapSale(sale);
    }catch(e){ await client.query('ROLLBACK'); throw e; }
    finally{ client.release(); }
  },
  // Clientes
  async listCustomers(tid){ const r=await q('SELECT * FROM customers WHERE tenant_id=$1 ORDER BY name',[tid]); return r.rows.map(mapCustomer); },
  async getCustomer(id,tid){ const r=await q('SELECT * FROM customers WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rows[0]?mapCustomer(r.rows[0]):null; },
  async createCustomer(input,tid){ const r=await q(`INSERT INTO customers(tenant_id,name,doc,phone,email,address,credit_limit,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[tid,String(input.name).trim(),input.doc||'',input.phone||'',input.email||'',input.address||'',Number(input.credit_limit)||0,input.notes||'']); return mapCustomer(r.rows[0]); },
  async updateCustomer(id,tid,input){ const sets=[],vals=[]; let i=1; ['name','doc','phone','email','address','notes'].forEach(k=>{ if(input[k]!==undefined){ sets.push(`${k}=$${i++}`); vals.push(input[k]); } }); if(input.credit_limit!==undefined){ sets.push(`credit_limit=$${i++}`); vals.push(Number(input.credit_limit)||0); } if(!sets.length) return this.getCustomer(id,tid); vals.push(Number(id)); vals.push(tid); const r=await q(`UPDATE customers SET ${sets.join(',')} WHERE id=$${i++} AND tenant_id=$${i} RETURNING *`,vals); return r.rows[0]?mapCustomer(r.rows[0]):null; },
  async deleteCustomer(id,tid){ const r=await q('DELETE FROM customers WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rowCount>0; },
  // Devoluciones / notas crédito
  async listReturns(tid){ const r=await q('SELECT * FROM returns WHERE tenant_id=$1 ORDER BY id DESC',[tid]); return r.rows.map(mapReturn); },
  // Unidades serializadas (IMEI / serial)
  async listUnits(tid,productId){ let r; if(productId) r=await q('SELECT * FROM units WHERE tenant_id=$1 AND product_id=$2 ORDER BY id DESC',[tid,Number(productId)]); else r=await q('SELECT * FROM units WHERE tenant_id=$1 ORDER BY id DESC',[tid]); return r.rows.map(mapUnit); },
  async findUnitByImei(tid,imei){ const r=await q('SELECT * FROM units WHERE tenant_id=$1 AND lower(btrim(imei))=lower(btrim($2)) LIMIT 1',[tid,String(imei||'')]); return r.rows[0]?mapUnit(r.rows[0]):null; },
  async createUnit(tid,productId,imei,note){ const im=String(imei||'').trim(); if(!im) throw { code:'VALIDACION', message:'IMEI/serial obligatorio' }; const ex=await q('SELECT 1 FROM units WHERE tenant_id=$1 AND lower(btrim(imei))=lower(btrim($2)) LIMIT 1',[tid,im]); if(ex.rows[0]) throw { code:'IMEI_EXISTE', message:'Ese IMEI/serial ya está registrado' }; const r=await q(`INSERT INTO units(tenant_id,product_id,imei,status,note) VALUES($1,$2,$3,'disponible',$4) RETURNING *`,[tid,Number(productId),im,note||'']); return mapUnit(r.rows[0]); },
  async bajaUnit(id,tid){ const r0=await q('SELECT * FROM units WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); const u=r0.rows[0]; if(!u) return null; if(u.status==='vendido') throw { code:'UNIDAD_VENDIDA', message:'No puedes dar de baja una unidad vendida' }; const r=await q("UPDATE units SET status='baja', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",[Number(id),tid]); return mapUnit(r.rows[0]); },
  // Sucursales / stock por sucursal
  async listBranches(tid){ try{ await q("UPDATE branches SET status='suspendida' WHERE tenant_id=$1 AND status='activo' AND vence IS NOT NULL AND vence < CURRENT_DATE",[tid]); }catch(e){} const r=await q('SELECT * FROM branches WHERE tenant_id=$1 ORDER BY id',[tid]); return r.rows.map(mapBranch); },
  async getBranch(id,tid){ const r=await q('SELECT * FROM branches WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rows[0]?mapBranch(r.rows[0]):null; },
  async createBranch(input,tid){ const tipo=input.plan_tipo||null; const ini=input.fecha_inicio||null; const vence=(planMonths(tipo)&&ini)?addMonths(ini,planMonths(tipo)):(input.vence||null); const r=await q(`INSERT INTO branches(tenant_id,name,address,phone,fecha_inicio,plan_tipo,plan_cost,vence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[tid,String(input.name).trim(),input.address||'',input.phone||'',ini,tipo,Number(input.plan_cost)||0,vence]); return mapBranch(r.rows[0]); },
  async updateBranch(id,tid,input){ const cur=await this.getBranch(id,tid); if(!cur) return null; const merged={ name:input.name!==undefined?input.name:cur.name, address:input.address!==undefined?input.address:cur.address, phone:input.phone!==undefined?input.phone:cur.phone, status:input.status!==undefined?input.status:cur.status, fecha_inicio:input.fecha_inicio!==undefined?(input.fecha_inicio||null):cur.fecha_inicio, plan_tipo:input.plan_tipo!==undefined?(input.plan_tipo||null):cur.plan_tipo, plan_cost:input.plan_cost!==undefined?(Number(input.plan_cost)||0):cur.plan_cost, vence:input.vence!==undefined?(input.vence||null):cur.vence }; const m=planMonths(merged.plan_tipo); if(m && merged.fecha_inicio && input.vence===undefined && (input.plan_tipo!==undefined||input.fecha_inicio!==undefined)) merged.vence=addMonths(merged.fecha_inicio,m); const r=await q(`UPDATE branches SET name=$1,address=$2,phone=$3,status=$4,fecha_inicio=$5,plan_tipo=$6,plan_cost=$7,vence=$8 WHERE id=$9 AND tenant_id=$10 RETURNING *`,[merged.name,merged.address,merged.phone,merged.status,merged.fecha_inicio,merged.plan_tipo,merged.plan_cost,merged.vence,Number(id),tid]); return r.rows[0]?mapBranch(r.rows[0]):null; },
  async deleteBranch(id,tid){ const bid=Number(id); const cnt=await q('SELECT COUNT(*) AS c FROM branches WHERE tenant_id=$1',[tid]); if(Number(cnt.rows[0].c)<=1) throw { code:'ULTIMA_SUCURSAL', message:'No puedes eliminar la única sucursal' }; const st=await q('SELECT COALESCE(SUM(qty),0) AS s FROM branch_stock WHERE branch_id=$1',[bid]); if(Number(st.rows[0].s)>0) throw { code:'SUCURSAL_CON_STOCK', message:'La sucursal tiene stock; trasládalo o ajústalo antes de eliminar' }; const r=await q('DELETE FROM branches WHERE id=$1 AND tenant_id=$2',[bid,tid]); await q('DELETE FROM branch_stock WHERE branch_id=$1',[bid]); return r.rowCount>0; },
  async defaultBranchId(tid){ const r=await q('SELECT id FROM branches WHERE tenant_id=$1 ORDER BY id LIMIT 1',[tid]); if(r.rows[0]) return r.rows[0].id; const ins=await q(`INSERT INTO branches(tenant_id,name) VALUES($1,'Principal') RETURNING id`,[tid]); return ins.rows[0].id; },
  async productStock(tid,productId){ const r=await q('SELECT s.branch_id, b.name AS branch_name, s.qty FROM branch_stock s JOIN branches b ON b.id=s.branch_id WHERE s.tenant_id=$1 AND s.product_id=$2 ORDER BY s.branch_id',[tid,Number(productId)]); return r.rows.map(x=>({ branch_id:x.branch_id, branch_name:x.branch_name, qty:Number(x.qty) })); },
  // Caja / turnos
  async listCashSessions(tid,opts={}){ const cond=['tenant_id=$1']; const vals=[tid]; let i=2; if(opts.status){ cond.push(`status=$${i++}`); vals.push(opts.status); } if(opts.user_id!=null){ cond.push(`user_id=$${i++}`); vals.push(Number(opts.user_id)); } const lim=Number(opts.limit)||200; const r=await q(`SELECT * FROM cash_sessions WHERE ${cond.join(' AND ')} ORDER BY id DESC LIMIT ${lim}`,vals); return r.rows.map(mapCashSession); },
  async getCashSession(id,tid){ const r=await q('SELECT * FROM cash_sessions WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); return r.rows[0]?mapCashSession(r.rows[0]):null; },
  async currentCashSession(tid,userId){ const r=await q("SELECT * FROM cash_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='abierta' ORDER BY id DESC LIMIT 1",[tid,Number(userId)]); return r.rows[0]?mapCashSession(r.rows[0]):null; },
  async openCashSession(tid,userId,branchId,opening){ const ex=await q("SELECT 1 FROM cash_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='abierta' LIMIT 1",[tid,Number(userId)]); if(ex.rows[0]) throw { code:'CAJA_ABIERTA', message:'Ya tienes una caja abierta' }; let bid; if(branchId!=null&&branchId!==''){ const b=await q('SELECT id FROM branches WHERE id=$1 AND tenant_id=$2',[Number(branchId),tid]); if(!b.rows[0]) throw { code:'SUCURSAL_INVALIDA', message:'Sucursal no válida' }; bid=b.rows[0].id; } else bid=await this.defaultBranchId(tid); const r=await q(`INSERT INTO cash_sessions(tenant_id,branch_id,user_id,opening_amount) VALUES($1,$2,$3,$4) RETURNING *`,[tid,bid,Number(userId),Number(opening)||0]); return mapCashSession(r.rows[0]); },
  async closeCashSession(id,tid,counted,notes){ const r0=await q('SELECT * FROM cash_sessions WHERE id=$1 AND tenant_id=$2',[Number(id),tid]); const s=r0.rows[0]; if(!s) return null; if(s.status!=='abierta') throw { code:'CAJA_CERRADA', message:'La caja ya está cerrada' }; const ci=await q("SELECT COALESCE(SUM(total),0) AS s FROM sales WHERE cash_session_id=$1 AND pay_method='efectivo' AND pay_status<>'credito'",[s.id]); const co=await q("SELECT COALESCE(SUM(total),0) AS s FROM returns WHERE cash_session_id=$1 AND sale_pay_status<>'credito'",[s.id]); const expected=Number(s.opening_amount)+Number(ci.rows[0].s)-Number(co.rows[0].s); const cnt=Number(counted)||0; const r=await q("UPDATE cash_sessions SET counted_amount=$1, expected_amount=$2, difference=$3, closed_at=now(), status='cerrada', notes=$4 WHERE id=$5 RETURNING *",[cnt,expected,cnt-expected,notes||'',s.id]); return mapCashSession(r.rows[0]); },
  async cashSessionSummary(s){ const ci=await q("SELECT COALESCE(SUM(total),0) AS s FROM sales WHERE cash_session_id=$1 AND pay_method='efectivo' AND pay_status<>'credito'",[s.id]); const av=await q('SELECT COUNT(*) AS c FROM sales WHERE cash_session_id=$1',[s.id]); const co=await q("SELECT COALESCE(SUM(total),0) AS s FROM returns WHERE cash_session_id=$1 AND sale_pay_status<>'credito'",[s.id]); const cashIn=Number(ci.rows[0].s), cashOut=Number(co.rows[0].s); return { cashIn, cashOut, ventas:Number(av.rows[0].c), expected:Number(s.opening_amount)+cashIn-cashOut }; },
  // Facturas de servicio (suscripción)
  async createServiceInvoice(o){ const r=await q(`INSERT INTO service_invoices(tenant_id,branch_id,numero,plan,periodo,amount,issued_at,due_date,status,email_to,sent) VALUES($1,$2,'TMP',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[Number(o.tenant_id),o.branch_id!=null?Number(o.branch_id):null,o.plan||null,o.periodo||o.plan||null,Number(o.amount)||0,o.issued_at!==undefined?o.issued_at:new Date().toISOString(),o.due_date||null,o.status||'pendiente',o.email_to||null,o.sent?1:0]); const inv=r.rows[0]; const numero='SVC-'+String(inv.id).padStart(5,'0'); await q('UPDATE service_invoices SET numero=$1 WHERE id=$2',[numero,inv.id]); inv.numero=numero; return mapServiceInvoice(inv); },
  async listServiceInvoices(tid){ let r; if(tid!=null) r=await q('SELECT * FROM service_invoices WHERE tenant_id=$1 ORDER BY id DESC',[Number(tid)]); else r=await q('SELECT * FROM service_invoices ORDER BY id DESC'); return r.rows.map(mapServiceInvoice); },
  async markInvoiceSent(id){ await q('UPDATE service_invoices SET sent=1 WHERE id=$1',[Number(id)]); },
  async getServiceInvoice(id){ const r=await q('SELECT * FROM service_invoices WHERE id=$1',[Number(id)]); return r.rows[0]?mapServiceInvoice(r.rows[0]):null; },
  async deleteServiceInvoice(id){ const r=await q('DELETE FROM service_invoices WHERE id=$1',[Number(id)]); return r.rowCount>0; },
  async listPendingInvoices(){ const r=await q("SELECT si.*, t.name AS tenant_name, b.name AS branch_name FROM service_invoices si LEFT JOIN tenants t ON t.id=si.tenant_id LEFT JOIN branches b ON b.id=si.branch_id WHERE si.status='pendiente' ORDER BY si.id DESC"); return r.rows.map(x=>({ ...mapServiceInvoice(x), tenant_name:x.tenant_name||null, branch_name:x.branch_name||null })); },
  async branchesForBilling(){ const r=await q("SELECT id,tenant_id,plan_tipo,plan_cost,vence,status FROM branches WHERE plan_tipo IS NOT NULL AND vence IS NOT NULL"); return r.rows.map(x=>({ id:x.id, tenant_id:x.tenant_id, plan_tipo:x.plan_tipo, plan_cost:Number(x.plan_cost)||0, vence:(x.vence instanceof Date?x.vence.toISOString().slice(0,10):String(x.vence).slice(0,10)), status:x.status, dias_restantes:diasRestantes(x.vence) })); },
  async pendingInvoiceFor(branchId,dueDate){ const r=await q("SELECT * FROM service_invoices WHERE branch_id=$1 AND status='pendiente' AND due_date=$2 LIMIT 1",[Number(branchId),dueDate]); return r.rows[0]?mapServiceInvoice(r.rows[0]):null; },
  async markInvoicePaid(id){ const r=await q("UPDATE service_invoices SET status='pagada', issued_at=now() WHERE id=$1 RETURNING *",[Number(id)]); return r.rows[0]?mapServiceInvoice(r.rows[0]):null; },
  async createReturn(input,tid,userId){
    const client=await pool.connect();
    try{
      await client.query('BEGIN'); await setLocalCtx(client, tid);
      const sr=await client.query('SELECT * FROM sales WHERE id=$1 AND tenant_id=$2',[Number(input.sale_id),tid]);
      const sale=sr.rows[0];
      if(!sale) throw { code:'VENTA_NO_EXISTE', message:'La venta no existe' };
      if(!Array.isArray(input.items)||!input.items.length) throw { code:'VALIDACION', message:'La devolución no tiene productos' };
      const pr=await client.query('SELECT items FROM returns WHERE sale_id=$1 AND tenant_id=$2',[sale.id,tid]);
      const prev={}; pr.rows.forEach(row=>(row.items||[]).forEach(it=>{ prev[it.product_id]=(prev[it.product_id]||0)+it.qty; }));
      const saleItems=sale.items||[];
      const lines=[];
      for(const it of input.items){ const pid=Number(it.product_id); const qty=Number(it.qty)||0; if(qty<=0) throw { code:'CANTIDAD_INVALIDA', message:'Cantidad inválida' }; const sold=saleItems.find(x=>x.product_id===pid); if(!sold) throw { code:'PRODUCTO_NO_EN_VENTA', message:`El producto ${pid} no está en la venta` }; const maxRet=sold.qty-(prev[pid]||0); if(qty>maxRet) throw { code:'CANTIDAD_EXCEDE', message:`No puedes devolver ${qty} de ${sold.name} (máximo ${maxRet})` }; lines.push({ pid, qty, price:sold.price, name:sold.name, imeis:(Array.isArray(it.imeis)&&it.imeis.length)?it.imeis.map(x=>String(x).trim()):null }); }
      let total=0; const items=[];
      for(const l of lines){ const sub=l.price*l.qty; total+=sub; const it2={ product_id:l.pid, name:l.name, price:l.price, qty:l.qty, total:sub }; if(l.imeis) it2.imeis=l.imeis; items.push(it2); }
      const base=Math.round(total/1.19), iva=total-base;
      const csr=await client.query("SELECT id FROM cash_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='abierta' LIMIT 1",[tid,userId]); const csid=csr.rows[0]?csr.rows[0].id:null;
      const ins=await client.query(`INSERT INTO returns(tenant_id,user_id,sale_id,sale_numero,sale_pay_status,numero,motivo,subtotal,iva,total,cash_session_id,items) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,[tid,userId,sale.id,sale.numero,sale.pay_status,'TMP',input.motivo||'',base,iva,total,csid,JSON.stringify(items)]);
      const ret=ins.rows[0]; const numero='NC-'+String(ret.id).padStart(5,'0');
      await client.query('UPDATE returns SET numero=$1 WHERE id=$2',[numero,ret.id]);
      const rbranch = sale.branch_id || await pgResolveBranch(client,tid,null);
      for(const l of lines){
        await client.query('UPDATE products SET stock=stock+$1, updated_at=now() WHERE id=$2 AND tenant_id=$3',[l.qty,l.pid,tid]);
        await client.query('INSERT INTO branch_stock(tenant_id,product_id,branch_id,qty) VALUES($1,$2,$3,$4) ON CONFLICT (product_id,branch_id) DO UPDATE SET qty=branch_stock.qty+EXCLUDED.qty',[tid,l.pid,rbranch,l.qty]);
        await client.query('INSERT INTO movements(tenant_id,product_id,type,qty,ref,branch_id) VALUES($1,$2,$3,$4,$5,$6)',[tid,l.pid,'devolucion',l.qty,numero,rbranch]);
        if(l.imeis){ if(l.imeis.length!==l.qty) throw { code:'IMEI_CANTIDAD', message:`La cantidad de IMEI no coincide con ${l.name}` }; for(const im of l.imeis){ const ur=await client.query("UPDATE units SET status='disponible', sale_id=NULL, updated_at=now() WHERE tenant_id=$1 AND product_id=$2 AND lower(btrim(imei))=lower(btrim($3)) AND status='vendido' AND sale_id=$4 RETURNING id",[tid,l.pid,im,sale.id]); if(!ur.rowCount) throw { code:'IMEI_INVALIDO', message:`IMEI ${im} no corresponde a esta venta` }; } }
      }
      await client.query('COMMIT'); ret.numero=numero; return mapReturn(ret);
    }catch(e){ await client.query('ROLLBACK'); throw e; }
    finally{ client.release(); }
  },
  async dashboard(tid){
    const d0=new Date(); d0.setHours(0,0,0,0); const d1=new Date(d0); d1.setDate(d1.getDate()+1);
    const s0=d0.toISOString(), s1=d1.toISOString();
    const s=await q(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS base, COUNT(*) AS cnt FROM sales WHERE tenant_id=$1 AND fecha>=$2 AND fecha<$3`,[tid,s0,s1]);
    const ventasHoy=Number(s.rows[0].total), baseHoy=Number(s.rows[0].base), cnt=Number(s.rows[0].cnt);
    const its=await q(`SELECT items FROM sales WHERE tenant_id=$1 AND fecha>=$2 AND fecha<$3`,[tid,s0,s1]);
    const pc=await q('SELECT id,cost FROM products WHERE tenant_id=$1',[tid]);
    const costMap={}; pc.rows.forEach(r=>{ costMap[r.id]=Number(r.cost); });
    let costo=0; its.rows.forEach(r=>{ (r.items||[]).forEach(it=>{ costo+=(costMap[it.product_id]||0)*it.qty; }); });
    const low=await q('SELECT COUNT(*) AS c FROM products WHERE tenant_id=$1 AND stock<stock_min',[tid]);
    return { ventasHoy, utilidad:baseHoy-costo, ticketPromedio: cnt?Math.round(ventasHoy/cnt):0, ventasCount:cnt, productosCount:pc.rows.length, lowStockCount:Number(low.rows[0].c) };
  }
};

// ---------- Repo activo + arranque de datos ----------
let repo = jsonRepo;
function makePool(){
  if(global.__TEST_PG_POOL__) return global.__TEST_PG_POOL__;
  const { Pool } = require('pg');
  let ssl=false;
  try{ const host=new URL(DATABASE_URL).hostname; if(host && host!=='localhost' && host!=='127.0.0.1') ssl={ rejectUnauthorized:false }; }
  catch(e){ ssl={ rejectUnauthorized:false }; }
  return new Pool({ connectionString:DATABASE_URL, ssl, max:Number(process.env.PG_POOL_MAX)||10 });
}
async function seedUser(o){ const hp=hashPw(o.password); return repo.createUser({ tenant_id:o.tenant_id, name:o.name, username:o.username, email:o.email||null, role:o.role, password_hash:hp.hash, password_salt:hp.salt, status:'activo' }); }
async function seedIfEmpty(){
  if((await repo.countUsers())>0) return;
  // Contraseñas iniciales: nunca hardcodeadas. Vienen de variables de entorno;
  // si no existen, se generan aleatorias fuertes y se imprimen una sola vez al sembrar.
  const superPass = process.env.SEED_SUPER_PASS || 'Soporte1';
  const demoPass  = process.env.SEED_DEMO_PASS  || crypto.randomBytes(9).toString('base64url');
  await seedUser({ tenant_id:null, name:'Soporte', username:'Soporte', role:'superadmin', password:superPass });
  const demo=await repo.createTenant({ name:'JEROTECH', nit:'901.234.567', email:'contacto@jerotech.co' });
  await seedUser({ tenant_id:demo.id, name:'DEMO', username:'DEMO', role:'admin', password:demoPass });
  for(const p of seedProducts) await repo.createProduct(p, demo.id);
  console.log('==================================================================');
  console.log('SEMILLA CREADA — credenciales iniciales (CÁMBIALAS al primer ingreso):');
  console.log('  Soporte      -> empresa: Nexu      usuario: Soporte       clave: '+(process.env.SEED_SUPER_PASS?'(SEED_SUPER_PASS)':superPass));
  console.log('  Demo (admin) -> empresa: JEROTECH  usuario: DEMO          clave: '+(process.env.SEED_DEMO_PASS ?'(SEED_DEMO_PASS)' :demoPass));
  console.log('==================================================================');
}
async function init(){
  if(USE_PG){
    pool = makePool();
    repo = pgRepo;
    const boot = global.__TEST_PG_POOL__ ? null : await pool.connect();
    const run = async ()=>{
      // B2: la RLS multiempresa exige un rol NO superusuario y SIN BYPASSRLS; de lo contrario el aislamiento sería falso.
      if(!global.__TEST_PG_POOL__){
        try{
          const rr=await q(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
          const role=rr.rows[0]||{};
          if(role.rolsuper || role.rolbypassrls){
            const msg='El rol de base de datos es superusuario o tiene BYPASSRLS: la RLS multiempresa NO se aplica. Usa un rol restringido.';
            if(process.env.NODE_ENV==='production'){ console.error('FATAL: '+msg); process.exit(1); }
            else console.error('ADVERTENCIA: '+msg+' (permitido fuera de producción)');
          }
        }catch(e){ console.error('No se pudo verificar el rol de BD:', e.message); }
      }
      for(const stmt of DDL) await q(stmt);
      for(const stmt of MIGRATIONS){ try{ await q(stmt); }catch(e){ /* columna ya existe o motor sin soporte */ } }
      for(const stmt of INDEXES){ try{ await q(stmt); }catch(e){ console.error('Índice omitido:', e.message); } }
      await seedIfEmpty();
      // H: sucursal "Principal" + stock por sucursal para datos existentes (idempotente)
      try{
        await q(`INSERT INTO branches(tenant_id,name) SELECT id,'Principal' FROM tenants t WHERE NOT EXISTS(SELECT 1 FROM branches b WHERE b.tenant_id=t.id)`);
        await q(`INSERT INTO branch_stock(tenant_id,product_id,branch_id,qty) SELECT p.tenant_id, p.id, (SELECT min(id) FROM branches b WHERE b.tenant_id=p.tenant_id), p.stock FROM products p WHERE NOT EXISTS(SELECT 1 FROM branch_stock s WHERE s.product_id=p.id)`);
      }catch(e){ console.error('Reconcile sucursales:', e.message); }
      // Normaliza el perfil principal: "Súper Admin" -> "Soporte"
      try{ await q("UPDATE users SET name='Soporte', username='Soporte' WHERE role='superadmin' AND (name='Súper Admin' OR username='Súper Admin')"); }catch(e){ console.error('Normaliza Soporte:', e.message); }
      if(!global.__TEST_PG_POOL__){
        for(const stmt of rlsStatements()){ try{ await q(stmt); }catch(e){ console.error('RLS:', e.message); } }
        RLS_ON = true;
        console.log('Seguridad RLS activada en: '+RLS_TABLES.join(', '));
      }
    };
    if(boot){
      // Contexto elevado: el arranque debe poder leer/sembrar aunque las tablas ya tengan RLS de un despliegue anterior
      await boot.query("SELECT set_config('app.super','on',false), set_config('app.tenant_id','',false)");
      try{ await als.run({ client:boot }, run); }
      finally{ try{ await boot.query('RESET ALL'); }catch(e){} boot.release(); }
    } else {
      await run();
    }
    console.log('Persistencia: PostgreSQL');
    return;
  }
  loadJson();
  repo = jsonRepo;
  console.log('Persistencia: archivo JSON (' + DB_PATH + ') — datos NO permanentes en Render free');
  await seedIfEmpty();
}

// ---------- Helpers de rutas ----------
const h = fn => (req,res) => Promise.resolve(fn(req,res)).catch(err=>{ console.error(err); if(!res.headersSent){ const status=err.status||500; const code=err.code||'ERROR'; const msg=(err.code||err.status)?(err.message||'Error'):'Error interno'; res.status(status).json({ error:{ code, message:msg } }); } });
async function toPublicUser(u){ const t = u.tenant_id ? await repo.getTenant(u.tenant_id) : null; return { id:u.id, name:u.name, username:u.username, email:u.email||null, role:u.role, tenant_id:u.tenant_id, status:u.status, tenant_name: t?t.name:(u.role==='superadmin'?'Nexu':null), tenant_logo: t?t.logo:null }; }
// Registro de auditoría. No bloquea la respuesta y nunca lanza (los fallos se ignoran).
function logAction(req, action, extra){
  extra = extra || {};
  try{
    const u = (req && req.user) || {};
    const tid = u.tenant_id!=null ? u.tenant_id : (extra.tenant_id!=null ? extra.tenant_id : null);
    const detail = extra.detail==null ? null : (typeof extra.detail==='string' ? extra.detail : JSON.stringify(extra.detail));
    Promise.resolve(repo.logAudit({
      actor_user_id: u.id!=null ? u.id : (extra.actor_user_id!=null ? extra.actor_user_id : null),
      actor_name: u.name || extra.actor_name || null,
      actor_role: u.role || extra.actor_role || null,
      tenant_id: tid, action,
      entity: extra.entity || null,
      entity_id: extra.entity_id,
      detail, ip: (req && req.ip) || null
    })).catch(()=>{});
  }catch(e){}
}
// Emite una factura de servicio para una empresa y la envía a su correo (stub si no hay SMTP)
async function emitirFacturaServicio(tenant){
  const inv=await repo.createServiceInvoice({ tenant_id:tenant.id, plan:tenant.plan_tipo, amount:tenant.plan_cost, due_date:tenant.vence, status:tenant.status, email_to:tenant.email });
  if(tenant.email){
    const body=[`Factura de servicio ${inv.numero}`,`Empresa: ${tenant.name}`,`Plan: ${tenant.plan||'—'}`,`Valor del plan: ${inv.amount}`,`Fecha de pago: ${String(inv.issued_at).slice(0,10)}`,`Fecha de vencimiento: ${inv.due_date||'—'}`,`Estado del servicio: ${inv.status}`].join('\n');
    const r=await sendEmail(tenant.email, `Factura de servicio ${inv.numero} - ${tenant.name}`, body);
    if(r.sent){ try{ await repo.markInvoiceSent(inv.id); }catch(e){} inv.sent=true; }
  }
  return inv;
}
// Revisión de vigencia: genera factura PENDIENTE para sedes con 5 días o menos
async function runBillingCheck(){
  try{ await runElevated(async()=>{
    const list=await repo.branchesForBilling();
    for(const b of list){
      if(b.status==='activo' && b.dias_restantes!=null && b.dias_restantes<=5){
        const ex=await repo.pendingInvoiceFor(b.id, b.vence);
        if(!ex){ const t=await repo.getTenant(b.tenant_id); await repo.createServiceInvoice({ tenant_id:b.tenant_id, branch_id:b.id, plan:b.plan_tipo, periodo:b.plan_tipo, amount:b.plan_cost, due_date:b.vence, status:'pendiente', issued_at:null, email_to:t&&t.email }); }
      }
    }
  }); }catch(e){ console.error('Billing check:', e.message); }
}
async function newUser(b){ const hp=hashPw(b.password||'changeme'); const username=String(b.username||'').trim(); return repo.createUser({ tenant_id: b.role==='superadmin'?null:Number(b.tenant_id), branch_id: b.role==='superadmin'?null:(b.branch_id||null), name:(b.name&&b.name.trim())||username, username, email:b.email||null, role:b.role||'tienda', password_hash:hp.hash, password_salt:hp.salt, status:'activo' }); }
// Verifica la contraseña del usuario en sesión (confirmación de acciones sensibles)
function confirmPw(req){ return verifyPw(String((req.body&&req.body.confirm_password)||''), req.user.password_hash, req.user.password_salt); }
// Ejecuta fn con contexto elevado (lee todo): para login y validación de sesión
async function runElevated(fn){
  if(!RLS_ON) return fn();
  // Contexto elevado (lee todo) sin retener conexión: cada q() aplica el contexto por consulta.
  return als.run({ tid:null, sup:true }, fn);
}
// Fija el contexto de empresa para el resto de la petición. No toma conexión:
// cada consulta (q) o transacción aplica el contexto sobre su propia conexión.
function enterContext(req,res,next,ctx){
  if(!RLS_ON) return next();
  als.run({ tid: ctx.tid==null?null:ctx.tid, sup: !!ctx.sup }, ()=>next());
}
async function authMw(req,res,next){
  try{
    const t=(req.headers.authorization||'').replace(/^Bearer /,'');
    const u = t ? await runElevated(()=>repo.sessionUser(t)) : null;
    if(!u||u.status!=='activo') return res.status(401).json({ error:{ code:'NO_AUTH', message:'Sesión inválida o expirada' } });
    req.user=u;
    // Empresa inactiva (suspensión manual) bloquea a todos; sede vencida/suspendida bloquea a sus usuarios
    if(u.role!=='superadmin' && u.tenant_id!=null){
      const tenant = await runElevated(()=>repo.getTenant(u.tenant_id));
      if(tenant && tenant.status!=='activo'){ try{ await repo.deleteSession(t); }catch(e){} return res.status(403).json({ error:{ code:'EMPRESA_INACTIVA', message:'La empresa está inactiva' } }); }
      if(u.branch_id){
        const today=new Date().toISOString().slice(0,10);
        const b=await runElevated(()=>repo.getBranch(u.branch_id, u.tenant_id));
        if(b){
          const expired = b.vence && today > String(b.vence).slice(0,10);
          if(expired && b.status==='activo'){ try{ await runElevated(()=>repo.updateBranch(b.id, u.tenant_id, { status:'suspendida' })); }catch(e){} }
          if(expired || b.status!=='activo'){ try{ await repo.deleteSession(t); }catch(e){} return res.status(403).json({ error:{ code:'SEDE_SUSPENDIDA', message:'La sede está suspendida por falta de pago. Contacta al proveedor.' } }); }
        }
      }
    }
    enterContext(req,res,next,{ tid: u.role==='superadmin'?null:u.tenant_id, sup: u.role==='superadmin' });
  }catch(e){ console.error(e); res.status(500).json({ error:{ code:'ERROR', message:'Error de autenticación' } }); }
}
function superMw(req,res,next){ if(req.user.role!=='superadmin') return res.status(403).json({ error:{ code:'PROHIBIDO', message:'Solo el súper-administrador' } }); next(); }
function storeMw(req,res,next){ if(req.user.tenant_id==null) return res.status(403).json({ error:{ code:'SIN_EMPRESA', message:'El súper-admin usa el panel de plataforma' } }); next(); }
function adminMw(req,res,next){ if(req.user.role!=='admin') return res.status(403).json({ error:{ code:'PROHIBIDO', message:'Solo el administrador de la empresa puede hacer esto' } }); next(); }

// ---------- Reportes (agregación pura) ----------
function buildReport(sales, purchases, products, from, to){
  const inRange = f => { const d=(f||'').slice(0,10); return d>=from && d<=to; };
  const costMap={}; products.forEach(p=>{ costMap[p.id]=Number(p.cost)||0; });
  const vs = sales.filter(s=>inRange(s.fecha));
  const cs = purchases.filter(p=>inRange(p.fecha));
  const ventasTotal = vs.reduce((a,s)=>a+s.total,0);
  const ventasBase  = vs.reduce((a,s)=>a+s.subtotal,0);
  const ventasIva   = vs.reduce((a,s)=>a+s.iva,0);
  const byProd={};
  vs.forEach(s=>(s.items||[]).forEach(it=>{
    const id=it.product_id;
    if(!byProd[id]) byProd[id]={ product_id:id, name:it.name, qty:0, ingresos:0, costo:0 };
    byProd[id].qty += it.qty;
    byProd[id].ingresos += it.total;
    byProd[id].costo += (costMap[id]||0)*it.qty;
  }));
  const porProducto = Object.values(byProd)
    .map(r=>{ const base=r.ingresos/1.19; const utilidad=Math.round(base)-r.costo; return { ...r, utilidad, margen: base>0?Math.round(utilidad/base*100):0 }; })
    .sort((a,b)=>b.ingresos-a.ingresos);
  const costoVendido = porProducto.reduce((a,r)=>a+r.costo,0);
  return {
    periodo:{ from, to },
    ventas:{ total:ventasTotal, base:ventasBase, iva:ventasIva, count:vs.length, ticket: vs.length?Math.round(ventasTotal/vs.length):0 },
    compras:{ total: cs.reduce((a,p)=>a+p.total,0), count:cs.length },
    utilidad: ventasBase - costoVendido,
    porProducto,
    inventario:{
      unidades: products.reduce((a,p)=>a+Number(p.stock),0),
      valorCosto: products.reduce((a,p)=>a+Number(p.stock)*Number(p.cost),0),
      valorVenta: products.reduce((a,p)=>a+Number(p.stock)*Number(p.price),0),
      productos: products.length,
      bajoStock: products.filter(p=>Number(p.stock)<Number(p.stock_min)).length
    }
  };
}

function buildFinance(sales, purchases, expenses, from, to, returns=[]){
  const inRange = f => { const d=(f||'').slice(0,10); return d>=from && d<=to; };
  const vs = sales.filter(s=>inRange(s.fecha));
  const cs = purchases.filter(p=>inRange(p.fecha));
  const gs = expenses.filter(e=>inRange(e.fecha));
  const rs = (returns||[]).filter(r=>inRange(r.fecha));
  const devolucionesPagadas = rs.filter(r=>r.sale_pay_status!=='credito').reduce((a,r)=>a+r.total,0); // reembolso en efectivo
  const devolucionesCredito = rs.filter(r=>r.sale_pay_status==='credito').reduce((a,r)=>a+r.total,0); // baja cuenta por cobrar
  const devoluciones = devolucionesPagadas + devolucionesCredito;
  const ingresos = vs.filter(s=>s.pay_status!=='credito').reduce((a,s)=>a+s.total,0) - devolucionesPagadas;
  const egresosCompras = cs.filter(p=>p.pay_status!=='credito').reduce((a,p)=>a+p.total,0);
  const egresosGastos = gs.reduce((a,e)=>a+e.monto,0);
  const catMap={}; gs.forEach(e=>{ catMap[e.categoria]=(catMap[e.categoria]||0)+e.monto; });
  const porCobrar = sales.filter(s=>s.pay_status==='credito');
  const porPagar  = purchases.filter(p=>p.pay_status==='credito');
  return {
    periodo:{ from, to },
    ingresos, egresosCompras, egresosGastos, devoluciones,
    flujoNeto: ingresos - egresosCompras - egresosGastos,
    porCobrarTotal: porCobrar.reduce((a,s)=>a+s.total,0) - devolucionesCredito,
    porPagarTotal: porPagar.reduce((a,p)=>a+p.total,0),
    porCobrar: porCobrar.map(s=>({ id:s.id, numero:s.numero, fecha:s.fecha, cliente:s.customer, total:s.total })),
    porPagar: porPagar.map(p=>({ id:p.id, numero:p.numero, fecha:p.fecha, proveedor:p.proveedor, total:p.total })),
    gastos: gs.map(e=>({ id:e.id, fecha:e.fecha, categoria:e.categoria, descripcion:e.descripcion, monto:e.monto })),
    gastosPorCategoria: Object.entries(catMap).map(([categoria,monto])=>({ categoria, monto })).sort((a,b)=>b.monto-a.monto)
  };
}

function buildInsights(products, sales, from, to){
  const inRange = f => { const d=(f||'').slice(0,10); return d>=from && d<=to; };
  const vendidos={}; sales.filter(s=>inRange(s.fecha)).forEach(s=>(s.items||[]).forEach(it=>{ vendidos[it.product_id]=(vendidos[it.product_id]||0)+it.qty; }));
  const agotados = products.filter(p=>Number(p.stock)===0).map(p=>({ name:p.name, stock_min:p.stock_min }));
  const bajoStock = products.filter(p=>Number(p.stock)>0 && Number(p.stock)<Number(p.stock_min)).map(p=>({ name:p.name, stock:p.stock, stock_min:p.stock_min, sugerido: Math.max(1, p.stock_min*2 - p.stock) }));
  const sinRotacion = products.filter(p=>Number(p.stock)>0 && !vendidos[p.id]).map(p=>({ name:p.name, stock:p.stock }));
  const margenBajo = products.filter(p=>Number(p.price)>0 && Number(p.cost)>0 && (p.price-p.cost)/p.price<0.15).map(p=>({ name:p.name, margen: Math.round((p.price-p.cost)/p.price*100) }));
  let top=null; Object.keys(vendidos).forEach(id=>{ if(!top||vendidos[id]>top.qty){ const pr=products.find(x=>x.id===Number(id)); top={ name:pr?pr.name:('#'+id), qty:vendidos[id] }; } });
  return { agotados, bajoStock, sinRotacion: sinRotacion.slice(0,12), margenBajo, topVendido:top };
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // 1 salto de proxy (Render) -> req.ip = IP real del cliente

// ----- CORS: seguro por defecto (mismo origen). Configurable con CORS_ORIGINS (lista separada por comas, o *) -----
const CORS_ORIGINS = (process.env.CORS_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
const corsAllowAll = CORS_ORIGINS.includes('*');
app.use((req,res,next)=>{
  const origin = req.headers.origin;
  if(origin && (corsAllowAll || CORS_ORIGINS.includes(origin))){
    res.setHeader('Access-Control-Allow-Origin', corsAllowAll ? '*' : origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age','600');
    if(!corsAllowAll) res.setHeader('Access-Control-Allow-Credentials','true');
  }
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

// ----- Cabeceras de seguridad -----
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Strict-Transport-Security','max-age=15552000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self'"
  ].join('; '));
  next();
});

app.use(express.json({ limit: '2mb' }));
const api = express.Router();

api.get('/health', (req,res)=>res.json({ ok:true, persistencia: USE_PG?'postgres':'json', ts:new Date().toISOString() }));

api.post('/auth/login', h((req,res)=>runElevated(async()=>{
  const { empresa, username, password } = req.body || {};
  const emp = String(empresa||'').trim();
  // Throttle por IP (defensa amplia contra fuerza bruta automatizada)
  if(ipThrottled(req.ip)) return res.status(429).json({ error:{ code:'DEMASIADOS_INTENTOS', message:'Demasiados intentos. Espera unos minutos.' } });
  // Lockout por cuenta (empresa+usuario)
  const key = loginKey(emp, username);
  const lockedMin = loginLockedMin(key);
  if(lockedMin) return res.status(429).json({ error:{ code:'BLOQUEO_TEMPORAL', message:`Cuenta bloqueada por intentos fallidos. Reintenta en ${lockedMin} min.` } });
  const fail = ()=>{ loginFail(key); logAction(req,'login_failed',{ tenant_id:tenantId, detail:{ empresa:emp, username } }); return res.status(401).json({ error:{ code:'CREDENCIALES', message:'Empresa, usuario o contraseña incorrectos' } }); };
  let tenant=null, tenantId=null;
  if(emp.toLowerCase()!=='nexu'){
    tenant = await repo.findTenantByName(emp);
    if(!tenant) return fail();
    tenantId = tenant.id;
  }
  const u = await repo.findUserByUsername(tenantId, username);
  if(!u || u.status!=='activo' || !verifyPw(password,u.password_hash,u.password_salt)) return fail();
  if(emp.toLowerCase()==='nexu' && u.role!=='superadmin') return fail();
  // Credenciales válidas: recién aquí se revela el estado de la empresa (evita enumeración)
  if(tenant && tenant.status!=='activo') return res.status(403).json({ error:{ code:'EMPRESA_INACTIVA', message:'La empresa está inactiva' } });
  if(u.branch_id){
    const today=new Date().toISOString().slice(0,10);
    const b=await repo.getBranch(u.branch_id, tenant?tenant.id:u.tenant_id);
    if(b){ const expired=b.vence && today>String(b.vence).slice(0,10); if(expired||b.status!=='activo') return res.status(403).json({ error:{ code:'SEDE_SUSPENDIDA', message:'La sede está suspendida por falta de pago.' } }); }
  }
  loginOk(key);
  try{ await repo.setLastLogin(u.id); }catch(e){}
  const token=randomToken(); await repo.createSession(token,u.id,Date.now()+7*24*3600*1000);
  logAction(req,'login',{ actor_user_id:u.id, actor_name:u.name, actor_role:u.role, tenant_id:tenantId, entity:'user', entity_id:u.id });
  res.json({ token, user: await toPublicUser(u) });
})));
api.get('/auth/me', authMw, h(async (req,res)=>res.json(await toPublicUser(req.user))));
api.post('/auth/logout', authMw, h(async (req,res)=>{ const t=(req.headers.authorization||'').replace(/^Bearer /,''); await repo.deleteSession(t); logAction(req,'logout',{ entity:'user', entity_id:req.user.id }); res.json({ ok:true }); }));
api.post('/auth/change-password', authMw, h(async (req,res)=>{
  const { current, next } = req.body || {};
  if(!next || String(next).length<8) return res.status(400).json({ error:{ code:'VALIDACION', message:'La nueva contraseña debe tener al menos 8 caracteres' } });
  const u=await repo.getUserById(req.user.id);
  if(!verifyPw(current, u.password_hash, u.password_salt)) return res.status(401).json({ error:{ code:'CLAVE_ACTUAL', message:'La contraseña actual es incorrecta' } });
  const hp=hashPw(next);
  await repo.updateUser(u.id, { password_hash:hp.hash, password_salt:hp.salt });
  res.json({ ok:true });
}));

// Recuperación de contraseña (email). Respuesta genérica para no revelar si el usuario existe.
api.post('/auth/forgot', h((req,res)=>runElevated(async()=>{
  const { empresa, username } = req.body || {};
  const emp=String(empresa||'').trim();
  let tenantId=null; if(emp.toLowerCase()!=='nexu'){ const t=await repo.findTenantByName(emp); if(t) tenantId=t.id; }
  const u=await repo.findUserByUsername(tenantId, username);
  const resp={ ok:true };
  if(u && u.email){ const token=randomToken(); await repo.createReset(token, u.id, Date.now()+3600*1000); await sendEmail(u.email, 'Recuperación de contraseña', `Tu código para restablecer la contraseña es: ${token}`); if(process.env.NODE_ENV!=='production') resp.dev_token=token; }
  res.json(resp);
})));
api.post('/auth/reset', h((req,res)=>runElevated(async()=>{
  const { token, password } = req.body || {};
  if(!token) return res.status(400).json({ error:{ code:'VALIDACION', message:'Falta el código' } });
  if(!password || String(password).length<8) return res.status(400).json({ error:{ code:'VALIDACION', message:'La contraseña debe tener al menos 8 caracteres' } });
  const u=await repo.resetUser(token);
  if(!u) return res.status(400).json({ error:{ code:'TOKEN_INVALIDO', message:'Código inválido o expirado' } });
  const hp=hashPw(password); await repo.updateUser(u.id, { password_hash:hp.hash, password_salt:hp.salt });
  await repo.deleteReset(token);
  logAction(req,'password_reset',{ actor_user_id:u.id, actor_name:u.name, actor_role:u.role, tenant_id:u.tenant_id, entity:'user', entity_id:u.id });
  res.json({ ok:true });
})));

// Súper-admin
api.get('/tenants', authMw, superMw, h(async (req,res)=>res.json(await repo.listTenants())));
api.post('/tenants', authMw, superMw, h(async (req,res)=>{
  const b=req.body||{};
  const name=String(b.name||'').trim();
  if(!name) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre de la empresa es obligatorio' } });
  if(name.toLowerCase()==='nexu') return res.status(400).json({ error:{ code:'NOMBRE_RESERVADO', message:'El nombre "Nexu" está reservado' } });
  if(await repo.findTenantByName(name)) return res.status(409).json({ error:{ code:'NOMBRE_EXISTE', message:'Ya existe una empresa con ese nombre' } });
  if(b.logo && String(b.logo).length>900000) return res.status(400).json({ error:{ code:'LOGO_GRANDE', message:'El logo es muy pesado (usa una imagen más liviana)' } });
  const venceCalc=computeVence(b);
  const created=await repo.createTenant({ name, nit:b.nit||'', email:b.email||null, contacto:b.contacto||null, telefono:b.telefono||null, fecha_inicio:b.fecha_inicio||null, fecha_creacion:b.fecha_creacion||null, vence:(venceCalc!=null?venceCalc:(b.vence||null)), plan:b.plan||null, plan_tipo:b.plan_tipo||null, plan_cost:b.plan_cost||0, logo:b.logo||null });
  logAction(req,'tenant_create',{ entity:'tenant', entity_id:created.id, detail:{ name, plan:created.plan, plan_cost:created.plan_cost } });
  let factura=null; try{ factura=await emitirFacturaServicio(created); logAction(req,'service_invoice',{ entity:'tenant', entity_id:created.id, detail:{ numero:factura.numero, amount:factura.amount } }); }catch(e){ console.error('Factura servicio:', e.message); }
  res.status(201).json({ ...created, factura });
}));
api.patch('/tenants/:id', authMw, superMw, h(async (req,res)=>{
  if(!confirmPw(req)) return res.status(403).json({ error:{ code:'PW_INCORRECTA', message:'Contraseña incorrecta' } });
  const b=req.body||{};
  const cur=await repo.getTenant(req.params.id);
  if(!cur) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } });
  if(b.name!==undefined){
    const name=String(b.name||'').trim();
    if(!name) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre no puede quedar vacío' } });
    if(name.toLowerCase()==='nexu') return res.status(400).json({ error:{ code:'NOMBRE_RESERVADO', message:'El nombre "Nexu" está reservado' } });
    if(name.trim().toLowerCase()!==String(cur.name).trim().toLowerCase()){ const dup=await repo.findTenantByName(name); if(dup && dup.id!==cur.id) return res.status(409).json({ error:{ code:'NOMBRE_EXISTE', message:'Ya existe una empresa con ese nombre' } }); }
  }
  if(b.logo && String(b.logo).length>900000) return res.status(400).json({ error:{ code:'LOGO_GRANDE', message:'El logo es muy pesado' } });
  const f={}; ['name','nit','email','contacto','telefono','vence','fecha_inicio','fecha_creacion','plan','plan_tipo','plan_cost','logo','status'].forEach(k=>{ if(b[k]!==undefined) f[k]=b[k]; });
  const venceCalc=computeVence(b); if(venceCalc!=null) f.vence=venceCalc;
  const t=await repo.updateTenant(req.params.id, f);
  logAction(req,'tenant_update',{ entity:'tenant', entity_id:Number(req.params.id), detail:{ fields:Object.keys(f) } });
  res.json(t);
}));
api.delete('/tenants/:id', authMw, superMw, h(async (req,res)=>{
  if(!confirmPw(req)) return res.status(403).json({ error:{ code:'PW_INCORRECTA', message:'Contraseña incorrecta' } });
  const ok=await repo.deleteTenant(req.params.id);
  if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } });
  logAction(req,'tenant_delete',{ entity:'tenant', entity_id:Number(req.params.id) });
  res.json({ deleted:true });
}));
api.post('/tenants/:id/impersonate', authMw, superMw, h(async (req,res)=>{
  if(!confirmPw(req)) return res.status(403).json({ error:{ code:'PW_INCORRECTA', message:'Contraseña incorrecta' } });
  const tid=Number(req.params.id);
  const t=await repo.getTenant(tid);
  if(!t) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } });
  const us=(await repo.listUsers()).filter(u=>u.tenant_id===tid && u.status==='activo');
  const target=us.find(u=>u.role==='admin')||us[0];
  if(!target) return res.status(400).json({ error:{ code:'SIN_USUARIOS', message:'La empresa no tiene usuarios activos' } });
  const full=await repo.getUserById(target.id);
  const token=randomToken(); await repo.createSession(token, full.id, Date.now()+2*3600*1000);
  logAction(req,'impersonate',{ entity:'tenant', entity_id:tid, detail:{ empresa:t.name, target_user:full.id } });
  res.json({ token, user: await toPublicUser(full), empresa:t.name });
}));
// Facturación de servicio (suscripción) — súper-admin
api.post('/tenants/:id/invoice', authMw, superMw, h(async (req,res)=>{ const t=await repo.getTenant(req.params.id); if(!t) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } }); const inv=await emitirFacturaServicio(t); logAction(req,'service_invoice',{ entity:'tenant', entity_id:Number(req.params.id), detail:{ numero:inv.numero, amount:inv.amount } }); res.status(201).json(inv); }));
api.get('/tenants/:id/invoices', authMw, superMw, h(async (req,res)=>res.json(await repo.listServiceInvoices(req.params.id))));
api.delete('/tenants/:id/invoices/:invId', authMw, superMw, h(async (req,res)=>{ const ok=await repo.deleteServiceInvoice(req.params.invId); if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Factura no encontrada' } }); logAction(req,'service_invoice_delete',{ entity:'tenant', entity_id:Number(req.params.id), detail:{ invoice:Number(req.params.invId) } }); res.json({ deleted:true }); }));
api.post('/tenants/:id/invoices/:invId/send', authMw, superMw, h(async (req,res)=>{ const inv=await repo.getServiceInvoice(req.params.invId); if(!inv) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Factura no encontrada' } }); const t=await repo.getTenant(req.params.id); const to=inv.email_to||(t&&t.email); if(!to) return res.status(400).json({ error:{ code:'SIN_CORREO', message:'La empresa no tiene correo registrado' } }); const body=['Factura de servicio '+inv.numero,'Empresa: '+(t?t.name:''),'Plan: '+(inv.plan||'—'),'Valor del plan: '+inv.amount,'Fecha de pago: '+String(inv.issued_at).slice(0,10),'Fecha de vencimiento: '+(inv.due_date||'—'),'Estado del servicio: '+inv.status].join('\n'); const r=await sendEmail(to, 'Factura de servicio '+inv.numero+(t?' - '+t.name:''), body); if(r.sent){ try{ await repo.markInvoiceSent(inv.id); }catch(e){} } logAction(req,'service_invoice_send',{ entity:'tenant', entity_id:Number(req.params.id), detail:{ invoice:inv.numero, sent:!!r.sent } }); res.json({ sent:!!r.sent, reason:r.reason||null }); }));
api.get('/tenants/:id/branches', authMw, superMw, h(async (req,res)=>res.json(await repo.listBranches(Number(req.params.id)))));
api.post('/tenants/:id/branches', authMw, superMw, h(async (req,res)=>{ const t=await repo.getTenant(req.params.id); if(!t) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } }); if(!req.body||!String(req.body.name||'').trim()) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre de la sucursal es obligatorio' } }); const b=await repo.createBranch(req.body, Number(req.params.id)); logAction(req,'branch_create',{ entity:'branch', entity_id:b.id, detail:{ tenant_id:Number(req.params.id), name:b.name } }); res.status(201).json(b); }));
api.put('/tenants/:id/branches/:bid', authMw, superMw, h(async (req,res)=>{ const b=await repo.updateBranch(req.params.bid, Number(req.params.id), req.body||{}); if(!b) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Sucursal no encontrada' } }); logAction(req,'branch_update',{ entity:'branch', entity_id:Number(req.params.bid) }); res.json(b); }));
api.delete('/tenants/:id/branches/:bid', authMw, superMw, h(async (req,res)=>{ try{ const ok=await repo.deleteBranch(req.params.bid, Number(req.params.id)); if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Sucursal no encontrada' } }); logAction(req,'branch_delete',{ entity:'branch', entity_id:Number(req.params.bid) }); res.json({ deleted:true }); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo eliminar' } }); } }));
api.get('/service-invoices', authMw, superMw, h(async (req,res)=>res.json(await repo.listServiceInvoices(null))));
// Registrar pago: reactiva, acumula días del plan y genera recibo
api.post('/tenants/:id/pay', authMw, superMw, h(async (req,res)=>{
  const t=await repo.getTenant(req.params.id);
  if(!t) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } });
  const months=planMonths(t.plan_tipo);
  if(!months) return res.status(400).json({ error:{ code:'SIN_TIPO', message:'Configura el tipo de plan antes de registrar el pago' } });
  const today=new Date().toISOString().slice(0,10);
  const vigente = t.vence && String(t.vence).slice(0,10) > today;  // ¿aún con días?
  const base = vigente ? String(t.vence).slice(0,10) : today;      // acumular sobre vence o desde hoy
  const newVence = addMonths(base, months);
  const f={ status:'activo', vence:newVence };
  if(!vigente) f.fecha_inicio=today;                                // periodo nuevo si estaba vencida/suspendida
  const updated=await repo.updateTenant(t.id, f);
  if(updated) updated.dias_restantes=diasRestantes(updated.vence);
  const recibo=await repo.createServiceInvoice({ tenant_id:t.id, plan:t.plan_tipo, amount:t.plan_cost, due_date:newVence, status:'activo', email_to:t.email });
  logAction(req,'service_payment',{ entity:'tenant', entity_id:t.id, detail:{ amount:t.plan_cost, periodo:t.plan_tipo, vence:newVence, reactivada:!vigente } });
  if(t.email){ const body=['Recibo de pago '+recibo.numero,'Empresa: '+t.name,'Valor pagado: '+t.plan_cost,'Periodo: '+(t.plan_tipo||''),'Nueva fecha de vencimiento: '+newVence,'Pago confirmado.'].join('\n'); const r=await sendEmail(t.email, 'Recibo de pago '+recibo.numero+' - '+t.name, body); if(r.sent){ try{ await repo.markInvoiceSent(recibo.id); }catch(e){} } }
  res.status(201).json({ tenant:updated, recibo });
}));
api.get('/pay-info', authMw, superMw, h(async (req,res)=>res.json({ bank:process.env.PAY_BANK||'', account:process.env.PAY_ACCOUNT||'', holder:process.env.PAY_HOLDER||'', info:process.env.PAY_INFO||'' })));
// Facturas pendientes (todas las sedes) — corre la revisión de vigencia primero
api.get('/invoices/pending', authMw, superMw, h(async (req,res)=>{ try{ await runBillingCheck(); }catch(e){} res.json(await repo.listPendingInvoices()); }));
// Registrar pago de una factura pendiente: marca pagada, reactiva y extiende la sede
api.post('/invoices/:id/pay', authMw, superMw, h(async (req,res)=>{
  const inv=await repo.getServiceInvoice(req.params.id);
  if(!inv) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Factura no encontrada' } });
  if(inv.status==='pagada') return res.status(409).json({ error:{ code:'YA_PAGADA', message:'La factura ya está pagada' } });
  const branch=inv.branch_id!=null?await repo.getBranch(inv.branch_id, inv.tenant_id):null;
  let updatedBranch=null;
  if(branch){
    const months=planMonths(branch.plan_tipo)||planMonths(inv.periodo);
    const today=new Date().toISOString().slice(0,10);
    const vigente=branch.vence && String(branch.vence).slice(0,10)>today;
    const newVence= months? addMonths(vigente?String(branch.vence).slice(0,10):today, months) : branch.vence;
    updatedBranch=await repo.updateBranch(branch.id, inv.tenant_id, { status:'activo', vence:newVence, fecha_inicio: vigente?branch.fecha_inicio:today });
  }
  const paid=await repo.markInvoicePaid(inv.id);
  logAction(req,'invoice_pay',{ entity:'branch', entity_id:branch?branch.id:null, detail:{ invoice:inv.numero, vence:updatedBranch?updatedBranch.vence:null } });
  res.json({ branch:updatedBranch, invoice:paid });
}));
// Registrar pago manual de una sede (genera recibo pagado y extiende)
api.post('/tenants/:id/branches/:bid/pay', authMw, superMw, h(async (req,res)=>{
  const tid=Number(req.params.id);
  const branch=await repo.getBranch(req.params.bid, tid);
  if(!branch) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Sede no encontrada' } });
  const months=planMonths(branch.plan_tipo);
  if(!months) return res.status(400).json({ error:{ code:'SIN_TIPO', message:'Configura el tipo de plan de la sede antes de registrar el pago' } });
  const today=new Date().toISOString().slice(0,10);
  const vigente=branch.vence && String(branch.vence).slice(0,10)>today;
  const newVence=addMonths(vigente?String(branch.vence).slice(0,10):today, months);
  const updatedBranch=await repo.updateBranch(branch.id, tid, { status:'activo', vence:newVence, fecha_inicio: vigente?branch.fecha_inicio:today });
  const t=await repo.getTenant(tid);
  const recibo=await repo.createServiceInvoice({ tenant_id:tid, branch_id:branch.id, plan:branch.plan_tipo, periodo:branch.plan_tipo, amount:branch.plan_cost, due_date:newVence, status:'pagada', email_to:t&&t.email });
  logAction(req,'invoice_pay',{ entity:'branch', entity_id:branch.id, detail:{ amount:branch.plan_cost, vence:newVence } });
  res.status(201).json({ branch:updatedBranch, recibo });
}));
api.post('/tenants/:id/bill/send', authMw, superMw, h(async (req,res)=>{ const t=await repo.getTenant(req.params.id); if(!t) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } }); if(!t.email) return res.status(400).json({ error:{ code:'SIN_CORREO', message:'La empresa no tiene correo registrado' } }); const body=['Factura de servicio - '+t.name,'Valor a pagar: '+(t.plan_cost||0),'','Datos para realizar el pago:','Banco / entidad: '+(process.env.PAY_BANK||'—'),'Número de cuenta: '+(process.env.PAY_ACCOUNT||'—'),'Titular: '+(process.env.PAY_HOLDER||'—'),(process.env.PAY_INFO||'')].join('\n'); const r=await sendEmail(t.email, 'Factura de servicio - '+t.name, body); logAction(req,'bill_send',{ entity:'tenant', entity_id:Number(req.params.id), detail:{ sent:!!r.sent } }); res.json({ sent:!!r.sent, reason:r.reason||null }); }));
api.get('/users', authMw, superMw, h(async (req,res)=>res.json(await repo.listUsers())));
api.post('/users', authMw, superMw, h(async (req,res)=>{
  const b=req.body||{};
  if(!b.username||!b.password) return res.status(400).json({ error:{ code:'VALIDACION', message:'Usuario y contraseña son obligatorios' } });
  if(String(b.password).length<8) return res.status(400).json({ error:{ code:'VALIDACION', message:'La contraseña debe tener al menos 8 caracteres' } });
  const role=(b.role==='superadmin')?'superadmin':((b.role==='admin')?'admin':'tienda');
  const tid = role==='superadmin' ? null : Number(b.tenant_id);
  if(role!=='superadmin' && !(await repo.getTenant(tid))) return res.status(400).json({ error:{ code:'EMPRESA_INVALIDA', message:'Empresa no válida' } });
  if(await repo.findUserByUsername(tid, b.username)) return res.status(409).json({ error:{ code:'USUARIO_EXISTE', message:'Ya existe ese usuario en la empresa' } });
  const nu=await newUser({ ...b, role });
  logAction(req,'user_create',{ entity:'user', entity_id:nu.id, detail:{ username:nu.username, role, tenant_id:tid } });
  res.status(201).json(await toPublicUser(nu));
}));
api.patch('/users/:id', authMw, superMw, h(async (req,res)=>{
  if(!confirmPw(req)) return res.status(403).json({ error:{ code:'PW_INCORRECTA', message:'Contraseña incorrecta' } });
  const target=await repo.getUserById(Number(req.params.id));
  if(!target) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Usuario no encontrado' } });
  const b=req.body||{}; const f={};
  if(b.name!==undefined) f.name=b.name;
  if(b.role!==undefined){ if(!['superadmin','admin','tienda'].includes(b.role)) return res.status(400).json({ error:{ code:'ROL_INVALIDO', message:'Rol no válido' } }); f.role=b.role; }
  if(b.status!==undefined){ if(!['activo','inactivo'].includes(b.status)) return res.status(400).json({ error:{ code:'ESTADO_INVALIDO', message:'Estado no válido' } }); f.status=b.status; }
  if(b.email!==undefined) f.email=b.email;
  if(b.username!==undefined && String(b.username).trim() && String(b.username).trim().toLowerCase()!==String(target.username||'').trim().toLowerCase()){
    const dup=await repo.findUserByUsername(target.tenant_id, b.username);
    if(dup && dup.id!==target.id) return res.status(409).json({ error:{ code:'USUARIO_EXISTE', message:'Ya existe ese usuario en la empresa' } });
    f.username=String(b.username).trim();
  }
  if(b.password){ if(String(b.password).length<8) return res.status(400).json({ error:{ code:'VALIDACION', message:'La contraseña debe tener al menos 8 caracteres' } }); const hp=hashPw(b.password); f.password_hash=hp.hash; f.password_salt=hp.salt; }
  const u=await repo.updateUser(req.params.id,f);
  logAction(req,'user_update',{ entity:'user', entity_id:Number(req.params.id), detail:{ fields:Object.keys(f) } });
  res.json(await toPublicUser(u));
}));
api.delete('/users/:id', authMw, superMw, h(async (req,res)=>{
  if(!confirmPw(req)) return res.status(403).json({ error:{ code:'PW_INCORRECTA', message:'Contraseña incorrecta' } });
  if(Number(req.params.id)===req.user.id) return res.status(400).json({ error:{ code:'AUTO_BLOQUEO', message:'No puedes eliminar tu propio usuario' } });
  const ok=await repo.deleteUser(req.params.id);
  if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Usuario no encontrado' } });
  logAction(req,'user_delete',{ entity:'user', entity_id:Number(req.params.id) });
  res.json({ deleted:true });
}));

// Auditoría (plataforma): el súper-admin ve todo; filtra por ?tenant_id= y ?limit=
api.get('/audit', authMw, superMw, h(async (req,res)=>res.json(await repo.listAudit({ tenant_id: req.query.tenant_id?Number(req.query.tenant_id):null, limit: Math.min(Number(req.query.limit)||200, 500) }))));

// Configuración de la empresa (autoservicio del administrador)
api.get('/company', authMw, storeMw, h(async (req,res)=>{ const t=await repo.getTenant(req.user.tenant_id); if(!t) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Empresa no encontrada' } }); res.json(t); }));
api.patch('/company', authMw, storeMw, adminMw, h(async (req,res)=>{ const f={}; if(req.body.name!==undefined) f.name=req.body.name; if(req.body.nit!==undefined) f.nit=req.body.nit; if(f.name!==undefined && !String(f.name).trim()) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre no puede quedar vacío' } }); const t=await repo.updateTenant(req.user.tenant_id, f); res.json(t); }));
api.get('/company/users', authMw, storeMw, adminMw, h(async (req,res)=>{ const us=(await repo.listUsers()).filter(u=>u.tenant_id===req.user.tenant_id); res.json(us); }));
api.post('/company/users', authMw, storeMw, adminMw, h(async (req,res)=>{
  const b=req.body||{};
  if(!b.username||!b.password) return res.status(400).json({ error:{ code:'VALIDACION', message:'Usuario y contraseña son obligatorios' } });
  if(String(b.password).length<8) return res.status(400).json({ error:{ code:'VALIDACION', message:'La contraseña debe tener al menos 8 caracteres' } });
  if(await repo.findUserByUsername(req.user.tenant_id, b.username)) return res.status(409).json({ error:{ code:'USUARIO_EXISTE', message:'Ya existe ese usuario en tu empresa' } });
  const role=(b.role==='admin')?'admin':'tienda';
  const u=await newUser({ name:b.name, username:b.username, email:b.email||null, password:b.password, role, tenant_id:req.user.tenant_id, branch_id:b.branch_id });
  logAction(req,'user_create',{ entity:'user', entity_id:u.id, detail:{ username:u.username, role } });
  res.status(201).json(await toPublicUser(u));
}));
api.patch('/company/users/:id', authMw, storeMw, adminMw, h(async (req,res)=>{
  const target=await repo.getUserById(Number(req.params.id));
  if(!target || target.tenant_id!==req.user.tenant_id) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Usuario no encontrado' } });
  const f={};
  if(req.body.name!==undefined) f.name=req.body.name;
  if(req.body.role!==undefined){ if(req.body.role!=='admin' && req.body.role!=='tienda') return res.status(400).json({ error:{ code:'ROL_INVALIDO', message:'Rol no válido' } }); f.role=req.body.role; }
  if(req.body.status!==undefined) f.status=req.body.status;
  if(req.body.branch_id!==undefined) f.branch_id=req.body.branch_id;
  if(target.id===req.user.id && ((f.status && f.status!=='activo') || (f.role && f.role!=='admin'))) return res.status(400).json({ error:{ code:'AUTO_BLOQUEO', message:'No puedes desactivar ni cambiar tu propio rol' } });
  if(req.body.password){ if(String(req.body.password).length<8) return res.status(400).json({ error:{ code:'VALIDACION', message:'La contraseña debe tener al menos 8 caracteres' } }); const hp=hashPw(req.body.password); f.password_hash=hp.hash; f.password_salt=hp.salt; }
  const u=await repo.updateUser(target.id, f);
  logAction(req,'user_update',{ entity:'user', entity_id:target.id, detail:{ fields:Object.keys(f) } });
  res.json(await toPublicUser(u));
}));

// Auditoría de la empresa: el administrador ve solo los eventos de su empresa
api.get('/company/audit', authMw, storeMw, adminMw, h(async (req,res)=>res.json(await repo.listAudit({ tenant_id: req.user.tenant_id, limit: Math.min(Number(req.query.limit)||200, 500) }))));

// Clientes (CRM) — por empresa
api.get('/customers', authMw, storeMw, h(async (req,res)=>res.json(await repo.listCustomers(req.user.tenant_id))));
api.get('/customers/:id', authMw, storeMw, h(async (req,res)=>{
  const c=await repo.getCustomer(req.params.id, req.user.tenant_id);
  if(!c) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Cliente no encontrado' } });
  const ventas=(await repo.listSales(req.user.tenant_id)).filter(s=>s.customer_id===c.id);
  const saldo=ventas.filter(s=>s.pay_status==='credito').reduce((a,s)=>a+s.total,0);
  res.json({ ...c, ventas, saldo, cupoDisponible: Number(c.credit_limit)>0 ? Math.max(0, Number(c.credit_limit)-saldo) : null });
}));
api.post('/customers', authMw, storeMw, h(async (req,res)=>{ if(!req.body||!String(req.body.name||'').trim()) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre del cliente es obligatorio' } }); const c=await repo.createCustomer(req.body, req.user.tenant_id); logAction(req,'customer_create',{ entity:'customer', entity_id:c.id, detail:{ name:c.name } }); res.status(201).json(c); }));
api.put('/customers/:id', authMw, storeMw, h(async (req,res)=>{ if(req.body && req.body.name!==undefined && !String(req.body.name).trim()) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre no puede quedar vacío' } }); const c=await repo.updateCustomer(req.params.id, req.user.tenant_id, req.body||{}); if(!c) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Cliente no encontrado' } }); logAction(req,'customer_update',{ entity:'customer', entity_id:Number(req.params.id) }); res.json(c); }));
api.delete('/customers/:id', authMw, storeMw, h(async (req,res)=>{ const ok=await repo.deleteCustomer(req.params.id, req.user.tenant_id); if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Cliente no encontrado' } }); logAction(req,'customer_delete',{ entity:'customer', entity_id:Number(req.params.id) }); res.json({ deleted:true }); }));

// Tienda (por empresa)
api.get('/products', authMw, storeMw, h(async (req,res)=>res.json(await repo.listProducts(req.user.tenant_id))));
api.get('/products/lookup', authMw, storeMw, h(async (req,res)=>{ const p=await repo.findProductByBarcode(req.user.tenant_id, req.query.barcode||''); if(!p) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Código de barras no encontrado' } }); res.json(p); }));
api.post('/products', authMw, storeMw, h(async (req,res)=>{ if(!req.body||!req.body.name) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre del producto es obligatorio' } }); res.status(201).json(await repo.createProduct(req.body, req.user.tenant_id)); }));
api.put('/products/:id', authMw, storeMw, h(async (req,res)=>{ const p=await repo.updateProduct(req.params.id, req.user.tenant_id, req.body||{}); if(!p) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Producto no encontrado' } }); res.json(p); }));
api.delete('/products/:id', authMw, storeMw, h(async (req,res)=>{ const ok=await repo.deleteProduct(req.params.id, req.user.tenant_id); if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Producto no encontrado' } }); res.json({ deleted:true }); }));
api.get('/products/:id/compatibles', authMw, storeMw, h(async (req,res)=>{ const id=Number(req.params.id); const all=await repo.listProducts(req.user.tenant_id); res.json(all.filter(p=>!p.device && Array.isArray(p.compat) && p.compat.includes(id) && p.stock>0)); }));
// Unidades serializadas (IMEI/serial) por producto
api.get('/products/:id/units', authMw, storeMw, h(async (req,res)=>res.json(await repo.listUnits(req.user.tenant_id, req.params.id))));
api.post('/products/:id/units', authMw, storeMw, h(async (req,res)=>{ const prod=await repo.getProduct(req.params.id, req.user.tenant_id); if(!prod) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Producto no encontrado' } }); try{ const u=await repo.createUnit(req.user.tenant_id, prod.id, (req.body||{}).imei, (req.body||{}).note); logAction(req,'unit_add',{ entity:'product', entity_id:prod.id, detail:{ imei:u.imei } }); res.status(201).json(u); }catch(e){ res.status(e.code==='VALIDACION'?400:409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo registrar la unidad' } }); } }));
api.get('/units/lookup', authMw, storeMw, h(async (req,res)=>{ const u=await repo.findUnitByImei(req.user.tenant_id, req.query.imei||''); if(!u) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'IMEI/serial no encontrado' } }); res.json(u); }));
api.delete('/units/:id', authMw, storeMw, h(async (req,res)=>{ try{ const u=await repo.bajaUnit(req.params.id, req.user.tenant_id); if(!u) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Unidad no encontrada' } }); logAction(req,'unit_baja',{ entity:'unit', entity_id:Number(req.params.id) }); res.json(u); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo dar de baja' } }); } }));
// Sucursales (multi-sucursal). Listar: cualquier usuario; crear/editar/eliminar: solo admin.
api.get('/branches', authMw, storeMw, h(async (req,res)=>res.json(await repo.listBranches(req.user.tenant_id))));
api.post('/branches', authMw, storeMw, adminMw, h(async (req,res)=>{ if(!req.body||!String(req.body.name||'').trim()) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre de la sucursal es obligatorio' } }); const b=await repo.createBranch(req.body, req.user.tenant_id); logAction(req,'branch_create',{ entity:'branch', entity_id:b.id, detail:{ name:b.name } }); res.status(201).json(b); }));
api.put('/branches/:id', authMw, storeMw, adminMw, h(async (req,res)=>{ if(req.body && req.body.name!==undefined && !String(req.body.name).trim()) return res.status(400).json({ error:{ code:'VALIDACION', message:'El nombre no puede quedar vacío' } }); const b=await repo.updateBranch(req.params.id, req.user.tenant_id, req.body||{}); if(!b) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Sucursal no encontrada' } }); logAction(req,'branch_update',{ entity:'branch', entity_id:Number(req.params.id) }); res.json(b); }));
api.delete('/branches/:id', authMw, storeMw, adminMw, h(async (req,res)=>{ try{ const ok=await repo.deleteBranch(req.params.id, req.user.tenant_id); if(!ok) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Sucursal no encontrada' } }); logAction(req,'branch_delete',{ entity:'branch', entity_id:Number(req.params.id) }); res.json({ deleted:true }); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo eliminar' } }); } }));
api.get('/products/:id/stock', authMw, storeMw, h(async (req,res)=>res.json(await repo.productStock(req.user.tenant_id, req.params.id))));
// Caja / arqueo / turnos
api.get('/cash-sessions', authMw, storeMw, h(async (req,res)=>res.json(await repo.listCashSessions(req.user.tenant_id, { status:req.query.status||null, user_id:req.query.mine?req.user.id:null, limit:Math.min(Number(req.query.limit)||100,300) }))));
api.get('/cash-sessions/current', authMw, storeMw, h(async (req,res)=>res.json(await repo.currentCashSession(req.user.tenant_id, req.user.id))));
api.get('/cash-sessions/:id', authMw, storeMw, h(async (req,res)=>{ const s=await repo.getCashSession(req.params.id, req.user.tenant_id); if(!s) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Caja no encontrada' } }); res.json({ ...s, resumen: await repo.cashSessionSummary(s) }); }));
api.post('/cash-sessions', authMw, storeMw, h(async (req,res)=>{ try{ const s=await repo.openCashSession(req.user.tenant_id, req.user.id, (req.body||{}).branch_id, (req.body||{}).opening_amount); logAction(req,'cash_open',{ entity:'cash_session', entity_id:s.id, detail:{ branch_id:s.branch_id, opening:s.opening_amount } }); res.status(201).json(s); }catch(e){ res.status(e.code==='SUCURSAL_INVALIDA'?400:409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo abrir la caja' } }); } }));
api.post('/cash-sessions/:id/close', authMw, storeMw, h(async (req,res)=>{ const cur=await repo.getCashSession(req.params.id, req.user.tenant_id); if(!cur) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Caja no encontrada' } }); if(cur.user_id!==req.user.id && req.user.role!=='admin') return res.status(403).json({ error:{ code:'PROHIBIDO', message:'Solo el dueño de la caja o un administrador puede cerrarla' } }); try{ const s=await repo.closeCashSession(req.params.id, req.user.tenant_id, (req.body||{}).counted_amount, (req.body||{}).notes); logAction(req,'cash_close',{ entity:'cash_session', entity_id:s.id, detail:{ expected:s.expected_amount, counted:s.counted_amount, difference:s.difference } }); res.json(s); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo cerrar la caja' } }); } }));
api.get('/sales', authMw, storeMw, h(async (req,res)=>{ let s=await repo.listSales(req.user.tenant_id); if(req.user.branch_id) s=s.filter(x=>x.branch_id===req.user.branch_id); res.json(s); }));
api.get('/sales/:id', authMw, storeMw, h(async (req,res)=>{ const s=await repo.getSale(req.params.id, req.user.tenant_id); if(!s) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Venta no encontrada' } }); res.json(s); }));
api.post('/sales', authMw, storeMw, h(async (req,res)=>{ try{ if(!req.body||!Array.isArray(req.body.items)||!req.body.items.length) return res.status(400).json({ error:{ code:'VALIDACION', message:'La venta no tiene productos' } }); if(req.user.branch_id) req.body.branch_id=req.user.branch_id; res.status(201).json(await repo.createSale(req.body, req.user.tenant_id, req.user.id)); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo registrar la venta' } }); } }));
api.get('/returns', authMw, storeMw, h(async (req,res)=>res.json(await repo.listReturns(req.user.tenant_id))));
api.post('/returns', authMw, storeMw, h(async (req,res)=>{ try{ if(!req.body||!req.body.sale_id) return res.status(400).json({ error:{ code:'VALIDACION', message:'Falta la venta a devolver' } }); const nc=await repo.createReturn(req.body, req.user.tenant_id, req.user.id); logAction(req,'sale_return',{ entity:'sale', entity_id:Number(req.body.sale_id), detail:{ numero:nc.numero, total:nc.total } }); res.status(201).json(nc); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo registrar la devolución' } }); } }));
api.get('/dashboard', authMw, storeMw, h(async (req,res)=>res.json(await repo.dashboard(req.user.tenant_id))));
api.get('/purchases', authMw, storeMw, h(async (req,res)=>res.json(await repo.listPurchases(req.user.tenant_id))));
api.post('/purchases', authMw, storeMw, h(async (req,res)=>{ try{ if(!req.body||!Array.isArray(req.body.items)||!req.body.items.length) return res.status(400).json({ error:{ code:'VALIDACION', message:'La entrada no tiene productos' } }); if(req.user.branch_id) req.body.branch_id=req.user.branch_id; res.status(201).json(await repo.createPurchase(req.body, req.user.tenant_id, req.user.id)); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo registrar la entrada' } }); } }));
api.get('/reports', authMw, storeMw, h(async (req,res)=>{
  const tid=req.user.tenant_id;
  const today=new Date();
  const to = req.query.to || today.toISOString().slice(0,10);
  const d0=new Date(today); d0.setDate(d0.getDate()-29);
  const from = req.query.from || d0.toISOString().slice(0,10);
  const [sales, purchases, products] = await Promise.all([ repo.listSales(tid), repo.listPurchases(tid), repo.listProducts(tid) ]);
  res.json(buildReport(sales, purchases, products, from, to));
}));
api.get('/movements', authMw, storeMw, h(async (req,res)=>{ let mv=await repo.listMovements(req.user.tenant_id, req.query.product_id||null); if(req.user.branch_id) mv=mv.filter(x=>x.branch_id===req.user.branch_id); res.json(mv); }));
api.post('/adjustments', authMw, storeMw, h(async (req,res)=>{ try{ if(!req.body||!req.body.product_id) return res.status(400).json({ error:{ code:'VALIDACION', message:'Falta seleccionar el producto' } }); if(req.user.branch_id) req.body.branch_id=req.user.branch_id; const mov=await repo.createAdjustment(req.body, req.user.tenant_id, req.user.id); logAction(req,'stock_adjustment',{ entity:'product', entity_id:Number(req.body.product_id), detail:{ type:req.body.type||'salida', qty:req.body.qty, motivo:req.body.motivo||null, newStock:mov.newStock } }); res.status(201).json(mov); }catch(e){ res.status(409).json({ error:{ code:e.code||'ERROR', message:e.message||'No se pudo registrar el movimiento' } }); } }));
api.get('/expenses', authMw, storeMw, h(async (req,res)=>res.json(await repo.listExpenses(req.user.tenant_id))));
api.post('/expenses', authMw, storeMw, h(async (req,res)=>{ if(!req.body||!(Number(req.body.monto)>0)) return res.status(400).json({ error:{ code:'VALIDACION', message:'El monto debe ser mayor a 0' } }); res.status(201).json(await repo.createExpense(req.body, req.user.tenant_id, req.user.id)); }));
api.patch('/sales/:id/pay', authMw, storeMw, h(async (req,res)=>{ const s=await repo.markSalePaid(req.params.id, req.user.tenant_id); if(!s) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Venta no encontrada' } }); res.json(s); }));
api.patch('/purchases/:id/pay', authMw, storeMw, h(async (req,res)=>{ const p=await repo.markPurchasePaid(req.params.id, req.user.tenant_id); if(!p) return res.status(404).json({ error:{ code:'NO_EXISTE', message:'Compra no encontrada' } }); res.json(p); }));
api.get('/finance', authMw, storeMw, h(async (req,res)=>{ const tid=req.user.tenant_id; const today=new Date(); const to=req.query.to||today.toISOString().slice(0,10); const d0=new Date(today); d0.setDate(d0.getDate()-29); const from=req.query.from||d0.toISOString().slice(0,10); const [s,p,e,rt]=await Promise.all([repo.listSales(tid),repo.listPurchases(tid),repo.listExpenses(tid),repo.listReturns(tid)]); res.json(buildFinance(s,p,e,from,to,rt)); }));
api.get('/insights', authMw, storeMw, h(async (req,res)=>{ const tid=req.user.tenant_id; const today=new Date(); const to=req.query.to||today.toISOString().slice(0,10); const d0=new Date(today); d0.setDate(d0.getDate()-29); const from=req.query.from||d0.toISOString().slice(0,10); const [pr,sa]=await Promise.all([repo.listProducts(tid),repo.listSales(tid)]); res.json(buildInsights(pr,sa,from,to)); }));

app.use('/api', api);

// Frontend
const HTML = fs.readFileSync(path.join(__dirname,'web','index.html'),'utf8');
app.get('*', (req,res)=>res.type('html').send(HTML));

async function start(){
  // B4: en producción no se permite el modo archivo JSON (sin RLS y datos efímeros).
  if(process.env.NODE_ENV==='production' && !USE_PG){
    console.error('FATAL: NODE_ENV=production sin DATABASE_URL. El modo archivo JSON no tiene RLS y pierde datos; no es válido en producción. Configura DATABASE_URL.');
    process.exit(1);
  }
  await init();
  try{ await runBillingCheck(); }catch(e){}
  const _bc=setInterval(()=>{ runBillingCheck().catch(()=>{}); }, 24*3600*1000); if(_bc.unref) _bc.unref();
  const PORT=process.env.PORT||3000; app.listen(PORT, ()=>console.log('Nexo Retail escuchando en http://localhost:'+PORT));
}
if(require.main === module){ start().catch(e=>{ console.error('Error al arrancar:', e); process.exit(1); }); }
module.exports = { app, init, start, getRepo:()=>repo, buildReport, buildFinance, buildInsights };
