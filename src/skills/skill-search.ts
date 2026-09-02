/**
 * Preselección de skills relevantes para un objetivo.
 *
 * Con bibliotecas grandes (varios repositorios → cientos de skills) no tiene
 * sentido mostrarle al arquitecto el catálogo completo: consume miles de tokens
 * y diluye la elección. Aplicamos la "progressive disclosure" del estándar
 * Agent Skills: el arquitecto ve solo las skills cuya `description` (y nombre)
 * se parecen al objetivo del usuario.
 *
 * El ranking es léxico y local (sin LLM ni red): TF-IDF simplificado sobre
 * tokens normalizados, con bonificaciones por coincidencia en el nombre y por
 * sinónimos español↔inglés del dominio habitual (las descripciones de GitHub
 * están casi siempre en inglés y el usuario escribe en español).
 *
 * Es deliberadamente sencillo: su trabajo es descartar el 90 % irrelevante,
 * no elegir con precisión — eso lo hace el arquitecto con las ~25 restantes.
 */
import { SkillInfo } from './types';

/** Palabras vacías en ambos idiomas que no aportan señal. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'this', 'that', 'is', 'are', 'be', 'when', 'use', 'used',
  'using', 'skill', 'skills', 'user', 'users', 'wants', 'want', 'any', 'all', 'from', 'by', 'as', 'at', 'it', 'its', 'into', 'you',
  'your', 'should', 'can', 'will', 'also', 'etc', 'including', 'includes', 'include', 'such', 'like', 'via', 'not', 'no', 'if',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del', 'al', 'a', 'en', 'con', 'para', 'por', 'que', 'se',
  'su', 'sus', 'es', 'son', 'ser', 'este', 'esta', 'esto', 'estos', 'estas', 'como', 'cuando', 'sobre', 'sin', 'muy', 'mas', 'más',
  'lo', 'le', 'les', 'me', 'te', 'nos', 'ya', 'si', 'sí', 'pero', 'también', 'tambien', 'hacer', 'haz', 'crea', 'crear', 'quiero',
  'necesito', 'usa', 'usar', 'debe', 'puede', 'archivo', 'archivos', 'file', 'files', 'code', 'código', 'codigo', 'proyecto', 'project'
]);

/**
 * Sinónimos/traducciones de dominio. Clave y valores se normalizan igual que
 * el texto. Cada término del objetivo se expande con su grupo completo.
 */
const SYNONYMS: string[][] = [
  ['datos', 'data', 'dataset', 'datasets', 'tabla', 'tablas', 'table', 'tables'],
  ['analisis', 'analysis', 'analyze', 'analyse', 'analizar', 'analitica', 'analytics', 'exploratory', 'eda', 'estadistica', 'estadistico', 'statistics', 'statistical', 'stats'],
  ['grafico', 'graficos', 'grafica', 'graficas', 'chart', 'charts', 'plot', 'plots', 'plotting', 'visualizacion', 'visualization', 'visualize', 'visual', 'figura', 'figuras', 'figure', 'dashboard', 'd3'],
  ['serie', 'series', 'temporal', 'temporales', 'timeseries', 'time', 'forecast', 'forecasting', 'pronostico', 'prediccion', 'prediction', 'arima', 'var'],
  ['econometria', 'econometrics', 'econometric', 'economia', 'economics', 'economic', 'macro', 'regresion', 'regression'],
  ['finanzas', 'financiero', 'financiera', 'financieros', 'finance', 'financial', 'mercado', 'market', 'markets', 'trading', 'precio', 'precios', 'price', 'prices', 'bolsa', 'stock', 'stocks', 'portfolio', 'cartera', 'riesgo', 'risk', 'valuation', 'valoracion', 'dcf'],
  ['api', 'apis', 'rest', 'endpoint', 'endpoints', 'cliente', 'client', 'http', 'request', 'requests', 'fetch', 'scraping', 'scrape', 'scraper'],
  ['informe', 'informes', 'reporte', 'reportes', 'report', 'reports', 'reporting', 'documento', 'documentos', 'document', 'documents', 'docx', 'word', 'pdf', 'memo', 'redactar', 'redaccion', 'writing', 'write', 'escribir'],
  ['presentacion', 'presentaciones', 'presentation', 'presentations', 'slides', 'slide', 'deck', 'decks', 'pptx', 'powerpoint', 'diapositivas', 'poster', 'posters'],
  ['excel', 'xlsx', 'xls', 'csv', 'spreadsheet', 'spreadsheets', 'hoja', 'hojas', 'calculo', 'planilla', 'planillas'],
  ['investigacion', 'investigar', 'research', 'literatura', 'literature', 'paper', 'papers', 'articulo', 'articulos', 'article', 'academico', 'academic', 'cientifico', 'scientific', 'estudio', 'study', 'review', 'revision', 'fuentes', 'sources', 'citas', 'citations', 'bibliografia'],
  ['web', 'website', 'sitio', 'pagina', 'paginas', 'page', 'pages', 'landing', 'html', 'css', 'frontend', 'react', 'nextjs', 'vue', 'ui'],
  ['diseno', 'design', 'designer', 'ux', 'ui', 'interfaz', 'interface', 'usabilidad', 'usability', 'accesibilidad', 'accessibility', 'wcag', 'estilo', 'style', 'tema', 'theme', 'marca', 'brand', 'branding', 'tipografia', 'typography', 'color', 'colores', 'colors', 'layout', 'maqueta', 'wireframe', 'prototipo', 'prototype', 'figma'],
  ['test', 'tests', 'testing', 'prueba', 'pruebas', 'probar', 'qa', 'validar', 'validacion', 'validation', 'verify', 'verificar', 'tdd', 'pytest', 'jest'],
  ['depurar', 'depuracion', 'debug', 'debugging', 'bug', 'bugs', 'error', 'errores', 'fallo', 'fallos', 'fix', 'arreglar', 'corregir', 'correccion'],
  ['base', 'database', 'databases', 'sql', 'postgres', 'postgresql', 'sqlite', 'mysql', 'query', 'queries', 'consulta', 'consultas', 'esquema', 'schema', 'migracion', 'migration'],
  ['despliegue', 'desplegar', 'deploy', 'deployment', 'produccion', 'production', 'docker', 'ci', 'cd', 'pipeline', 'devops', 'servidor', 'server', 'cloud', 'nube'],
  ['documentacion', 'documentation', 'docs', 'readme', 'manual', 'guia', 'guide', 'tutorial', 'adr', 'wiki'],
  ['plan', 'planificar', 'planificacion', 'planning', 'proyecto', 'project', 'roadmap', 'tareas', 'tasks', 'requisitos', 'requirements', 'spec', 'especificacion', 'prd', 'producto', 'product', 'gestion', 'management', 'brainstorm', 'brainstorming', 'ideas'],
  ['regulacion', 'regulacion', 'regulatory', 'regulation', 'normativa', 'compliance', 'cumplimiento', 'legal', 'ley', 'leyes', 'law', 'audit', 'auditoria', 'riesgos'],
  ['python', 'pandas', 'numpy', 'statsmodels', 'scipy', 'sklearn', 'jupyter', 'notebook', 'r', 'rstudio', 'julia', 'matlab'],
  ['javascript', 'typescript', 'node', 'nodejs', 'js', 'ts', 'npm'],
  ['ml', 'machine', 'learning', 'aprendizaje', 'modelo', 'modelos', 'model', 'models', 'entrenar', 'train', 'training', 'llm', 'ia', 'ai', 'agente', 'agentes', 'agent', 'agents', 'prompt', 'prompts'],
  ['imagen', 'imagenes', 'image', 'images', 'foto', 'photo', 'icono', 'iconos', 'icon', 'icons', 'svg', 'png', 'ilustracion', 'illustration', 'arte', 'art', 'generativo', 'generative'],
  ['video', 'videos', 'audio', 'podcast', 'musica', 'music', 'voz', 'voice', 'tts'],
  ['email', 'correo', 'newsletter', 'marketing', 'campana', 'campaign', 'seo', 'contenido', 'content', 'redes', 'social', 'blog', 'post']
];

/** Índice término → grupo de sinónimos, con la misma normalización que `tokenize()`. */
const SYNONYM_INDEX = new Map<string, Set<string>>();
for (const group of SYNONYMS) {
  const normalized = [...new Set(group.map(t => singularize(normalizeToken(t))))];
  for (const term of normalized) {
    const set = SYNONYM_INDEX.get(term) ?? new Set<string>();
    normalized.forEach(t => set.add(t));
    SYNONYM_INDEX.set(term, set);
  }
}

export interface RankedSkill {
  skill: SkillInfo;
  score: number;
  /** Términos del objetivo que coincidieron (para explicar la selección). */
  matched: string[];
}

export interface SelectOptions {
  /** Máximo de skills a devolver. */
  limit?: number;
  /** Skills que siempre se incluyen (p. ej. las asignadas manualmente por el usuario). */
  pinned?: string[];
  /** Fuentes que se priorizan cuando hay empate (p. ej. `bundled`, `local`). */
  preferredSources?: string[];
}

/** Quita acentos, pasa a minúsculas y deja solo letras/dígitos. */
export function normalizeToken(token: string): string {
  return token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Tokeniza un texto libre en términos significativos (sin stopwords, con singularización básica). */
export function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeToken)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(singularize);
}

/**
 * Singularización muy básica en ambos idiomas: `graficos`→`grafico`, `charts`→`chart`,
 * `analyses`→`analysis`, `stories`→`story`, pero `series`→`serie` (no `sery`).
 * Es una aproximación: basta con que las dos caras (objetivo y descripción) se
 * normalicen igual.
 */
export function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('yses')) return token.slice(0, -2) + 'is';           // analyses → analysis
  if (token.endsWith('ies') && !/[aeiou]ries$/.test(token) && !/^(series|especies|superficies)$/.test(token)) return token.slice(0, -3) + 'y';
  if (token.endsWith('ses') || token.endsWith('xes')) return token.slice(0, -2);
  if (token.endsWith('es') && !/[aeiou]es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('is') && !token.endsWith('us')) return token.slice(0, -1);
  return token;
}

/**
 * Raíz aproximada para emparejar cognados español↔inglés sin diccionario:
 * `literatura`/`literature` → `literat`, `academica`/`academic` → `academ`,
 * `cita`/`citation` → `cit`… Se usa como coincidencia débil (peso menor).
 */
export function stem(token: string): string {
  return token
    .replace(/(aciones|acion|ations|ation|ación)$/, 'a')
    .replace(/(mente|ment|ly)$/, '')
    .replace(/(idad|ity|ities)$/, '')
    .replace(/(ica|ico|ical|ic)$/, '')
    .replace(/(ura|ure)$/, '')
    .replace(/(ivo|iva|ive)$/, '')
    .replace(/(ario|aria|ary)$/, '')
    .replace(/[aeiou]+$/, '')
    .slice(0, 6);
}

/** Expande cada término con sus sinónimos. Devuelve un mapa término → peso (los sinónimos pesan menos que el original). */
function expandQuery(tokens: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const token of tokens) {
    weights.set(token, Math.max(weights.get(token) ?? 0, 1));
    for (const syn of SYNONYM_INDEX.get(token) ?? []) {
      if (syn !== token) weights.set(syn, Math.max(weights.get(syn) ?? 0, 0.6));
    }
  }
  return weights;
}

/**
 * Ordena las skills por relevancia respecto al objetivo y devuelve las mejores.
 *
 * - Cada término del objetivo (y sus sinónimos) aporta según su IDF en la
 *   biblioteca: un término que aparece en todas las skills no discrimina.
 * - Coincidir en el `name` vale el doble que en la descripción.
 * - Las skills `pinned` van siempre; las fuentes preferidas desempatan.
 */
export function selectRelevantSkills(skills: SkillInfo[], goal: string, options: SelectOptions = {}): RankedSkill[] {
  const { limit = 25, pinned = [], preferredSources = ['local', 'bundled'] } = options;
  if (!skills.length) return [];

  const query = expandQuery(tokenize(goal));
  const queryStems = new Set([...query.keys()].map(stem).filter(r => r.length >= 4));
  const docs = skills.map(skill => {
    const nameTokens = tokenize(skill.name.replace(/-/g, ' '));
    const descTokens = tokenize(skill.description);
    return {
      skill,
      nameTokens: new Set(nameTokens),
      descTokens: countTokens(descTokens),
      stems: new Set([...nameTokens, ...descTokens].map(stem))
    };
  });

  // IDF por término sobre la descripción + nombre.
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set([...doc.nameTokens, ...doc.descTokens.keys()]);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (term: string) => Math.log(1 + docs.length / (1 + (df.get(term) ?? 0)));

  const ranked: RankedSkill[] = docs.map(doc => {
    let score = 0;
    const matched: string[] = [];
    const matchedStems = new Set<string>();
    for (const [term, weight] of query) {
      const inName = doc.nameTokens.has(term);
      const inDesc = doc.descTokens.get(term) ?? 0;
      if (inName || inDesc) {
        // Saturación logarítmica: 5 menciones no valen 5 veces más que 1.
        const tf = (inName ? 2 : 0) + Math.log(1 + inDesc);
        score += weight * idf(term) * tf;
        if (weight === 1) matched.push(term);
        matchedStems.add(stem(term));
        continue;
      }
      // Coincidencia débil por raíz (cognados es/en): `literatura` ~ `literature`.
      const root = stem(term);
      if (root.length >= 4 && queryStems.has(root) && doc.stems.has(root) && !matchedStems.has(root)) {
        score += weight * 0.4 * Math.log(1 + docs.length / 10);
        matchedStems.add(root);
        if (weight === 1) matched.push(`${term}~`);
      }
    }
    if (preferredSources.includes(doc.skill.sourceId) && score > 0) score *= 1.15;
    return { skill: doc.skill, score, matched };
  });

  const pinnedSet = new Set(pinned);
  const chosen = ranked
    .filter(r => r.score > 0 || pinnedSet.has(r.skill.name))
    .sort((a, b) => {
      const pa = pinnedSet.has(a.skill.name) ? 1 : 0;
      const pb = pinnedSet.has(b.skill.name) ? 1 : 0;
      return pb - pa || b.score - a.score || a.skill.name.localeCompare(b.skill.name);
    });

  return chosen.slice(0, Math.max(limit, pinned.length));
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}
