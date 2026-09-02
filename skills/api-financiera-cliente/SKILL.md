---
name: api-financiera-cliente
description: Buenas prácticas para implementar clientes de APIs financieras y de datos económicos (bancos centrales, bolsas, proveedores de precios, APIs regulatorias). Úsala al escribir código que consulte una API REST con autenticación, paginación, límites de tasa o series históricas, y al diseñar la capa de caché y validación de esos datos.
license: MIT
metadata:
  author: multi-agent-bridge
  version: "1.0"
---

# Cliente de API financiera

## Principios
1. **Los datos financieros son evidencia**: guarda la respuesta cruda (JSON/CSV) con marca de tiempo antes de transformarla. Permite auditar y reproducir.
2. **Nunca credenciales en el código**: léelas de variables de entorno o de un archivo `.env` ignorado por git. Falla al arrancar si faltan, con un mensaje claro.
3. **Idempotencia**: repetir una descarga no debe duplicar registros; usa claves naturales (fecha + instrumento + fuente).

## Estructura recomendada
```
cliente/
├── config.py       # URL base, timeouts, credenciales desde entorno
├── http.py         # sesión con reintentos exponenciales (429/5xx), User-Agent, timeout
├── endpoints.py    # una función por endpoint; devuelve tipos tipados/dataclasses
├── cache.py        # caché en disco (parquet/sqlite) por (endpoint, parámetros, fecha)
└── validate.py     # esquemas: fechas monótonas, sin duplicados, rangos plausibles
```

## Reglas concretas
- **Límites de tasa**: respeta `Retry-After`; si no existe, backoff exponencial con jitter (1s, 2s, 4s… máx. 60s). Registra cada espera.
- **Paginación**: sigue `next`/cursor hasta agotar; nunca asumas un número fijo de páginas. Protege con un máximo configurable.
- **Fechas y zonas horarias**: normaliza a UTC en almacenamiento; conserva la zona original como columna si es relevante para el mercado.
- **Validación mínima** antes de guardar: columnas esperadas presentes, fechas ordenadas y únicas, precios > 0, volúmenes ≥ 0, sin saltos de fecha inexplicados en series diarias (fuera de fines de semana/festivos).
- **Versionado de esquema**: si la API cambia campos, falla ruidosamente con un diff de columnas; no rellenes en silencio.

## Pruebas
- Graba respuestas reales en `tests/fixtures/` (anonimizadas) y prueba contra ellas sin red.
- Un test específico para 429 con `Retry-After` y otro para paginación truncada.

## Entrega
Documenta en el README: endpoints usados, límites conocidos del proveedor, cómo obtener la credencial, y cómo regenerar la caché.
