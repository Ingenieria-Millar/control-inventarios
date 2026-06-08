# ERP SaaS — Retail de Tecnología
## Fase 4: Diseño UX/UI

> Sistema de diseño, inventario de pantallas, wireframes y el prototipo navegable. Marca de trabajo: **Nexo Retail** (nombre sugerido, ajustable).

---

## 1. Principios de UX

- **Velocidad en el POS:** vender en pocos toques; búsqueda y escaneo siempre a la mano; teclado numérico grande en móvil.
- **Densidad legible:** mucha información (inventario, reportes) sin saturar; jerarquía tipográfica clara y cifras en fuente monoespaciada para alinear columnas.
- **Acciones primero:** lo que el rol usa a diario va arriba y visible; lo administrativo queda en configuración.
- **Estados claros:** color y etiqueta para stock (disponible / bajo / agotado), estado DIAN (aceptada / pendiente / rechazada) y cartera (al día / vencida).
- **Responsive real:** la misma app se adapta de escritorio (bodega, gerencia) a móvil (vendedor en piso).

---

## 2. Sistema de diseño (design tokens)

**Color**
| Token | Valor | Uso |
|---|---|---|
| `--ink` | `#12141C` | Barra lateral, botones primarios, texto |
| `--paper` | `#F1F2F5` | Fondo de la aplicación |
| `--surface` | `#FFFFFF` | Tarjetas y tablas |
| `--line` | `#E4E6EC` | Bordes y separadores |
| `--lime` | `#C8F439` | Acento de marca, estados activos, IA |
| `--emerald` | `#11B884` | Positivo, cobrar, ingresos |
| `--amber` | `#F59E0B` | Advertencia, stock bajo |
| `--danger` | `#E5484D` | Error, agotado, anular |

**Tipografía**
- Display / títulos: **Archivo** (600–800) — carácter industrial, ideal para retail.
- Cuerpo: **Hanken Grotesk** (400–600) — legible y neutra.
- Cifras / SKU / IMEI: **JetBrains Mono** — alinea números y da identidad técnica.

**Forma y profundidad:** radios de 10–14 px, sombras suaves de dos capas, borde de 1 px en superficies. **Espaciado** en escala de 4 px (4, 8, 12, 16, 20, 26). **Microinteracciones:** transiciones de 130 ms, aparición escalonada de las tarjetas KPI al cargar, barras animadas en gráficos.

---

## 3. Inventario de pantallas

**Web / Panel (escritorio)**
1. Login multiempresa
2. Dashboard gerencial (KPIs, ventas 7 días, alertas, top productos, resumen financiero)
3. Inventario (tabla con filtros, estados de stock, buscador)
4. Ficha de producto (variantes, compatibilidades, stock por sede, kardex)
5. POS / Ventas (catálogo, carrito, compatibilidad automática, medios de pago)
6. Compras (órdenes, cotizaciones, recepción)
7. Clientes / CRM (lista, ficha, segmentos, puntos)
8. Reportes (kardex, rotación, rentabilidad, ventas)
9. Configuración (empresas, sedes, usuarios y roles, resoluciones DIAN, impuestos, listas de precio)
10. Auditoría (bitácora)

**App móvil (Android/iOS)**
- POS móvil con escáner de cámara
- Consulta rápida de stock y precio
- Recepción de mercancía con escaneo
- Alertas push (stock, cartera, ventas del día)
- Dashboard resumido

---

## 4. Wireframes (estructura de las pantallas clave)

**Login** — Split screen: panel izquierdo de marca (propuesta de valor + métricas), panel derecho con selector de empresa, usuario, contraseña y botón de ingreso.

**Layout general** — Barra lateral fija (logo + navegación agrupada + usuario) · barra superior (selector de sede, buscador global, alertas, asistente IA, perfil) · área de contenido.

**Dashboard** — Fila de 4 tarjetas KPI (ventas, utilidad, ticket promedio, alertas) · gráfico de ventas semanal (2/3) + panel de alertas inteligentes (1/3) · productos más vendidos + resumen financiero.

**Inventario** — Encabezado con acciones (escanear, nueva referencia) · buscador + chips de categoría · tabla: producto, SKU, marca, categoría, barra de stock + estado, precio, badge de estado.

**POS** — Dos columnas: izquierda catálogo en grilla (con tag "Dispositivo") + buscador/escáner; derecha apilada con el panel **Compatibilidad automática** (oscuro, acento lima) arriba y el carrito abajo (cliente, ítems con cantidades, subtotal/IVA/total, medios de pago, botón "Cobrar y facturar").

**Ficha de producto** — Cabecera con imagen y datos · pestañas: Variantes · Compatibilidades · Stock por sede · Kardex · Garantía.

> Estos wireframes están **implementados y navegables** en el archivo `Nexo-Retail-Prototipo.html` (login → dashboard → inventario → POS con compatibilidad funcionando). Es responsive y usa datos de ejemplo en pesos colombianos con IVA del 19%.

---

## 5. Qué sigue

**Fase 5 — APIs:** especificación de la API REST (convenciones, autenticación, paginación, errores y endpoints por módulo).
