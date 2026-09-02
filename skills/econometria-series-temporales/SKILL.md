---
name: econometria-series-temporales
description: Flujo de trabajo reproducible para analizar series temporales económicas y financieras con Python (pandas, statsmodels). Úsala cuando la tarea implique estacionariedad, raíces unitarias, cointegración, modelos ARIMA/VAR/VECM, pronósticos o diagnósticos de residuos sobre datos macro o de mercado.
license: MIT
metadata:
  author: multi-agent-bridge
  version: "1.0"
---

# Econometría de series temporales

Sigue estos pasos en orden y deja constancia de cada decisión en el reporte final.

## 1. Preparación de datos
- Indexa por fecha (`pd.DatetimeIndex`) con frecuencia explícita (`asfreq`), y documenta cómo tratas huecos (festivos, faltantes).
- Trabaja en logaritmos para precios/niveles positivos; en diferencias o retornos para dinámica.
- Nunca mezcles frecuencias sin remuestrear de forma explícita (`resample('M').last()` vs `.mean()`: elige y justifica).

## 2. Estacionariedad
- Aplica **ADF** (`statsmodels.tsa.stattools.adfuller`) y **KPSS** juntos: conclusiones opuestas indican raíz unitaria dudosa → reporta ambas.
- Elige el número de rezagos por criterio de información (AIC/BIC), no a ojo.
- Si hay quiebres estructurales evidentes (crisis, cambio de régimen), menciónalo: ADF pierde potencia.

## 3. Modelado
- Series estacionarias univariadas → ARIMA (`statsmodels.tsa.arima.model.ARIMA`); elige orden con `pmdarima.auto_arima` si está disponible o por rejilla AIC.
- Varias series I(1) → prueba de **cointegración de Johansen** (`coint_johansen`). Si cointegran → **VECM**; si no → **VAR en diferencias**.
- Selecciona el orden del VAR con `VAR.select_order()` y reporta AIC, BIC y HQIC.

## 4. Diagnósticos (obligatorios)
- Residuos: Ljung-Box (autocorrelación), Jarque-Bera (normalidad), ARCH-LM (heterocedasticidad).
- Estabilidad: raíces del polinomio característico dentro del círculo unitario.
- Si falla un diagnóstico, no lo ocultes: propone la corrección (más rezagos, GARCH para varianza, dummies de quiebre).

## 5. Reporte
Genera `reporte.md` con: fuente y periodo de los datos, transformaciones, tablas de pruebas (estadístico, p-valor, conclusión), modelo elegido y por qué, diagnósticos, y limitaciones. Guarda las figuras en `figuras/` como PNG y SVG.

## Plantilla de código
Usa `scripts/analisis_base.py` como punto de partida: carga, pruebas de raíz unitaria y resumen en Markdown.
