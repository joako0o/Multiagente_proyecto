---
name: visualizacion-d3
description: Convenciones para construir gráficos financieros y económicos con d3.js v7 (series temporales, velas, áreas apiladas, small multiples). Úsala cuando la tarea sea crear o corregir una visualización web con d3, exportarla a SVG/PNG o hacerla responsive y accesible.
license: MIT
metadata:
  author: multi-agent-bridge
  version: "1.0"
---

# Visualización con d3.js v7

## Estructura de un gráfico
- Separa **datos → escalas → ejes → marcas → interacción** en funciones pequeñas. Una función `render(data, opciones)` idempotente que se pueda llamar al redimensionar.
- Usa el patrón de márgenes convencional (`{top, right, bottom, left}`) y calcula `innerWidth/innerHeight`.
- Importa d3 desde `node_modules` o un archivo local; evita depender de un CDN en producción.

## Series temporales
- Parsea fechas con `d3.timeParse`/`d3.isoParse` y usa `d3.scaleTime` (o `scaleUtc` para datos normalizados a UTC).
- Ejes temporales: `d3.axisBottom(x).ticks(d3.timeMonth.every(3))` según el rango; formatea con `d3.timeFormat` en el idioma del usuario (`d3.timeFormatLocale` con `es-ES`/`es-CL`).
- Escala de valores: `d3.scaleLinear().nice()`; para precios con órdenes de magnitud distintos, `d3.scaleLog` y dilo en el título del eje.
- Formatea números con `d3.formatLocale` (separador de miles `.`, decimal `,` para español) y unidades explícitas (%, CLP, USD, millones).

## Buenas prácticas financieras
- Muestra siempre la **fuente** y la **fecha de corte** de los datos en el gráfico (pie de figura).
- Para comparar series con escalas distintas prefiere **base 100** o dos paneles antes que un doble eje.
- Velas: `d3.scaleBand` para el eje temporal discreto; colorea alcista/bajista con dos colores accesibles y no solo rojo/verde (añade forma o patrón).

## Interacción y accesibilidad
- Tooltip con `pointer` (`d3.pointer(event)`) y `d3.bisector` para encontrar el punto más cercano en series densas.
- `<title>`/`<desc>` en el SVG y `aria-label` en el contenedor; contraste mínimo 4.5:1; no dependas solo del color.
- Responsive: `viewBox` + `preserveAspectRatio`, y `ResizeObserver` para volver a renderizar.

## Exportación
- SVG: serializa el nodo con `XMLSerializer` incluyendo los estilos inline (los CSS externos no viajan).
- PNG: dibuja el SVG serializado en un `canvas` con `devicePixelRatio` ≥ 2 para nitidez.

## Entrega
Incluye un `index.html` mínimo que cargue el gráfico con datos de ejemplo (`data/ejemplo.csv`) y un párrafo en el README con las decisiones de diseño (escalas, colores, agregaciones).
