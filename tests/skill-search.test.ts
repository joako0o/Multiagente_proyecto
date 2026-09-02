/**
 * Ranking léxico de skills frente a un objetivo (sin red, biblioteca sintética).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevantSkills, tokenize, normalizeToken } from '../src/skills/skill-search';
import { SkillInfo } from '../src/skills/types';

function skill(name: string, description: string, sourceId = 'repo/x'): SkillInfo {
  return { name, description, sourceId, dir: `/lib/${name}`, relPath: name, files: [], bodyBytes: 100 };
}

const library: SkillInfo[] = [
  skill('pdf', 'Extract text and tables from PDF files, fill forms, merge documents.'),
  skill('xlsx', 'Create, read and edit Excel spreadsheets; formulas, pivot tables, charts from tabular data.'),
  skill('pptx', 'Build PowerPoint presentations and slide decks with native shapes and speaker notes.'),
  skill('chart-visualization', 'Generate charts and plots from data: line, bar, scatter; export PNG/SVG.'),
  skill('literature-review', 'Systematic literature reviews across academic databases; synthesis of papers and citations.'),
  skill('frontend-design', 'Design and implement modern, accessible web pages and landing pages with good typography.'),
  skill('kubernetes-operations', 'Operate Kubernetes clusters: deployments, helm, autoscaling, incident response.'),
  skill('react-native-architecture', 'Architecture patterns for React Native mobile apps: navigation, state, offline.'),
  skill('timesfm-forecasting', 'Time series forecasting with TimesFM foundation model; zero-shot predictions.'),
  skill('econometria-series-temporales', 'Flujo reproducible para series temporales: estacionariedad, cointegración, ARIMA/VAR, diagnósticos.', 'bundled'),
  skill('visualizacion-d3', 'Convenciones para gráficos financieros con d3.js v7: escalas temporales, ejes, accesibilidad.', 'bundled'),
  skill('unrelated-blockchain', 'Smart contracts, Solidity audits and DeFi protocol integration.')
];

describe('tokenize', () => {
  test('normaliza acentos, minúsculas, stopwords y plurales', () => {
    assert.equal(normalizeToken('Gráficos!'), 'graficos');
    assert.deepEqual(tokenize('Crea unos gráficos de las series temporales'), ['grafico', 'serie', 'temporal']);
    assert.deepEqual(tokenize('Analyses of the charts'), ['analysis', 'chart']);
  });
});

describe('selectRelevantSkills', () => {
  test('un objetivo en español encuentra skills descritas en inglés vía sinónimos', () => {
    const top = selectRelevantSkills(library, 'Prepara una presentación con diapositivas para el comité', { limit: 3 });
    assert.equal(top[0].skill.name, 'pptx');
  });

  test('coincidencia en el nombre pesa más que en la descripción', () => {
    const top = selectRelevantSkills(library, 'necesito trabajar un pdf', { limit: 2 });
    assert.equal(top[0].skill.name, 'pdf');
  });

  test('las fuentes bundled/local desempatan a favor', () => {
    const top = selectRelevantSkills(library, 'gráfico de series temporales financieras con d3', { limit: 4 });
    const names = top.map(r => r.skill.name);
    assert.ok(names.indexOf('visualizacion-d3') < names.indexOf('chart-visualization'), names.join(','));
    assert.ok(names.includes('econometria-series-temporales'));
  });

  test('encuentra cognados español↔inglés sin diccionario (literatura ~ literature) y descarta lo irrelevante', () => {
    const top = selectRelevantSkills(library, 'revisión de literatura académica con citas', { limit: 3 });
    assert.equal(top[0].skill.name, 'literature-review');
    assert.ok(top[0].matched.some(m => m.startsWith('literatura')));
    assert.ok(!top.some(r => r.skill.name === 'unrelated-blockchain'));
    assert.ok(!top.some(r => r.skill.name === 'kubernetes-operations'));
  });

  test('el límite se respeta con objetivos amplios', () => {
    const top = selectRelevantSkills(library, 'datos, gráficos, tablas, presentación, documentos y web', { limit: 3 });
    assert.equal(top.length, 3);
  });

  test('las skills pinned se incluyen aunque no coincidan y van primero', () => {
    const top = selectRelevantSkills(library, 'landing page accesible', { limit: 2, pinned: ['unrelated-blockchain'] });
    assert.equal(top[0].skill.name, 'unrelated-blockchain');
    assert.equal(top[1].skill.name, 'frontend-design');
  });

  test('sin coincidencias devuelve vacío (el coordinador mostrará una nota)', () => {
    assert.deepEqual(selectRelevantSkills(library, 'zzzz qqqq'), []);
  });

  test('explica qué términos coincidieron', () => {
    const top = selectRelevantSkills(library, 'forecasting de series', { limit: 2 });
    const timesfm = top.find(r => r.skill.name === 'timesfm-forecasting')!;
    assert.ok(timesfm, 'timesfm-forecasting debe estar entre las dos primeras');
    assert.deepEqual(timesfm.matched, ['forecasting', 'serie']);
  });
});
