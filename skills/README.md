# Skills incluidas

Skills propias del proyecto en formato [Agent Skills](https://agentskills.io/specification),
orientadas al perfil de trabajo del usuario (econometría, APIs financieras, visualización con d3.js).

El servidor indexa esta carpeta al arrancar (`SKILLS_BUNDLED_DIRS`, por defecto `./skills`), así que
aparecen en la biblioteca junto a las de los repositorios remotos y el arquitecto puede asignarlas.
Para skills personales fuera del repositorio usa `<SKILLS_CACHE_DIR>/local/<name>/SKILL.md`.

| Skill | Para qué |
|---|---|
| `econometria-series-temporales` | Flujo estándar de análisis de series: estacionariedad, cointegración, VAR/ARIMA, diagnósticos y reporte reproducible. |
| `api-financiera-cliente` | Cómo construir un cliente robusto para APIs financieras (paginación, límites de tasa, caché, validación, secretos). |
| `visualizacion-d3` | Convenciones para gráficos financieros con d3.js v7: estructura, escalas, ejes temporales, accesibilidad y exportación. |

## Crear una skill nueva

```
skills/mi-skill/
├── SKILL.md        ← obligatorio: frontmatter (name, description) + instrucciones
├── scripts/        ← opcional: código reutilizable que el agente puede ejecutar
└── references/     ← opcional: documentación que el agente lee bajo demanda
```

Reglas del `name`: minúsculas, dígitos y guiones; debe coincidir con el nombre de la carpeta.
La `description` debe decir **qué hace y cuándo usarla**: es lo único que ve el arquitecto al elegir.
