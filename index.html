# ERP SaaS — Retail de Tecnología
## Fase 6: Componentes de Inteligencia Artificial

> Arquitectura de las funciones con IA. Se apoyan en un **microservicio Python (FastAPI)** para modelos de ML/visión y en un **modelo LLM (p. ej. Claude API de Anthropic)** para lenguaje natural. Conviene verificar modelos y precios vigentes al momento de implementar.

---

## 1. Arquitectura general de IA

```
   App (web/móvil) ──▶ API NestJS ──▶ Servicio IA (FastAPI/Python)
                          │                    │
                          │              ┌─────┴───────────────┐
                          │              │ LLM (NL · voz)      │
                          │              │ Modelos de demanda  │
                          │              │ Visión (productos)  │
                          │              └─────────────────────┘
                          ▼
                 PostgreSQL (datos del tenant)
```

**Regla de oro multi-tenant:** la IA solo accede a los datos de la empresa que pregunta. Las herramientas que el modelo puede invocar están **acotadas por `tenant_id` en el servidor** y son de **solo lectura** para consultas; nunca hay acceso cruzado entre empresas.

---

## 2. Componentes diferenciadores

### 2.1 Compatibilidad automática
Relación N:M entre dispositivos y accesorios (`product_compatibilities`). Al agregar un celular en el POS o abrir su ficha, el sistema consulta los accesorios compatibles **con stock disponible** y los sugiere. (Ya funciona en el prototipo.) La carga inicial de compatibilidades puede asistirse con IA a partir del nombre/specs del producto.

### 2.2 Asistente empresarial en lenguaje natural
Un LLM con **function-calling**: traduce la pregunta del usuario («¿qué debo comprar?», «¿qué no se vende?», «¿cuál es mi margen?», «¿qué vendedor rinde mejor?») en llamadas a las APIs de reportes/inventario/ventas, recibe los datos reales y responde con cifras y, cuando aplica, un gráfico. Se le entrega contexto del rol y la sede; las respuestas se registran para auditoría.

### 2.3 Predicción de demanda
Modelo de **serie temporal** por variante/sede (arranque con métodos estadísticos tipo media móvil/estacionalidad; evolución a modelos ML). Estima ventas futuras, fecha probable de agotamiento y cantidad sugerida de reposición, alimentando las alertas y las órdenes de compra asistidas.

### 2.4 IA visual (reconocimiento de productos)
El usuario toma una foto; un modelo de **visión** identifica el tipo/modelo y precarga los campos de la nueva referencia (categoría, marca, atributos), acelerando el alta de catálogo. Útil también para verificar recepciones.

### 2.5 Mapa inteligente de bodega
Usa `locations` (pasillo/estante/bin) por sede. Muestra la ubicación exacta de cada producto y la ruta de picking; con datos de rotación, recomienda reubicar lo más vendido cerca de la salida.

### 2.6 ERP por voz
Voz → **transcripción (speech-to-text)** → el mismo motor del asistente NL resuelve la intención → respuesta hablada (**text-to-speech**). Pensado para consultas con manos ocupadas en bodega o piso de venta.

### 2.7 Simulador de decisiones
Motor de proyección «qué pasaría si»: cambia precio, promoción, nivel de inventario o apertura de sede y estima impacto en ventas, margen y caja, combinando datos históricos con la predicción de demanda.

### 2.8 Gemelo digital del negocio
Modelo virtual de la empresa (inventario, ventas, finanzas, sedes) que permite correr escenarios futuros y comparar contra el desempeño real. Es la capa que integra predicción + simulador en una vista única de planeación.

### 2.9 Red colaborativa entre tiendas
Las empresas que **opten explícitamente** pueden compartir disponibilidad de inventario para referirse clientes o conseguir un producto agotado en otra tienda de la red. Solo se comparte lo autorizado (existencia/ubicación general), nunca costos, clientes ni datos sensibles.

### 2.10 Alertas inteligentes
Reglas + IA detectan stock bajo/agotado, próximos vencimientos de lote, cartera vencida y anomalías (caída de ventas, faltante en arqueo) y generan alertas priorizadas en el dashboard y por push.

---

## 3. Consideraciones transversales

- **Privacidad y datos personales:** cumplimiento de la Ley 1581 de 2012; los datos de clientes no se exponen a terceros ni a la red colaborativa.
- **Costos de IA:** las operaciones se ejecutan de forma asíncrona (colas) y se cachean resultados (p. ej. pronósticos diarios) para controlar el consumo.
- **Trazabilidad:** toda consulta del asistente y toda predicción quedan registradas (`ai_queries`, `demand_forecasts`).
- **Degradación elegante:** si un servicio de IA no responde, el ERP sigue operando con sus reglas básicas (alertas por umbral, compatibilidad por catálogo).

---

## 4. Qué sigue

**Fase 7 — Roadmap, backlog y monetización:** plan de entregas por releases, backlog priorizado y estrategia de monetización SaaS con precios.
