/**
 * Eye on the Sky — dashboard.js
 * Procesamiento en lote de archivos JSON del estudiante
 * Genera estadísticas del curso, alertas y vistas de detalle
 */

'use strict';

/* ================================================================
   ESTADO DEL DASHBOARD
   ================================================================ */

const Dash = {
  students:   [],       // Array de proyectos parseados
  sortCol:    'student_name',
  sortAsc:    true,
  charts:     {},
  detailStudent: null,
};

/* ================================================================
   INICIALIZACIÓN
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initUploadZone();
  initEventListeners();
  restoreTheme();
});

function initUploadZone() {
  const zone  = document.getElementById('upload-zone');
  const input = document.getElementById('json-file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    loadFiles(Array.from(e.dataTransfer.files));
  });

  input.addEventListener('change', () => loadFiles(Array.from(input.files)));
}

function initEventListeners() {
  document.getElementById('dash-btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-export-report').addEventListener('click', exportCSV);
  document.getElementById('dash-search').addEventListener('input', renderTable);
  document.getElementById('dash-filter-alert').addEventListener('change', renderTable);
  document.getElementById('close-student-detail').addEventListener('click', () => {
    document.getElementById('student-detail').classList.add('hidden');
    Dash.detailStudent = null;
  });

  // Ordenamiento por columna
  document.querySelectorAll('#students-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (Dash.sortCol === col) Dash.sortAsc = !Dash.sortAsc;
      else { Dash.sortCol = col; Dash.sortAsc = true; }
      renderTable();
    });
  });
}

/* ================================================================
   CARGA Y PARSEO DE ARCHIVOS JSON
   ================================================================ */

async function loadFiles(files) {
  const jsonFiles = files.filter(f => f.name.endsWith('.json'));
  if (jsonFiles.length === 0) {
    showToast('Ningún archivo .json fue seleccionado.', 'warning');
    return;
  }

  showToast(`Cargando ${jsonFiles.length} archivo(s)…`, 'success');

  const results = await Promise.allSettled(jsonFiles.map(parseStudentFile));
  let loaded = 0;
  let errors = 0;

  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      // Evitar duplicados por nombre del proyecto
      const existingIdx = Dash.students.findIndex(s => s._filename === r.value._filename);
      if (existingIdx >= 0) Dash.students[existingIdx] = r.value;
      else Dash.students.push(r.value);
      loaded++;
    } else {
      errors++;
      console.warn(`Error en ${jsonFiles[i].name}:`, r.reason);
    }
  });

  showToast(`${loaded} proyecto(s) cargado(s).${errors > 0 ? ` ${errors} con error.` : ''}`, loaded > 0 ? 'success' : 'error');

  if (Dash.students.length > 0) {
    document.getElementById('dash-main').classList.remove('hidden');
    renderCourseStats();
    renderCharts();
    renderTable();

    // Actualizar label del curso
    const courses = [...new Set(Dash.students.map(s => s.metadata?.course).filter(Boolean))];
    document.getElementById('dash-course-label').textContent = courses.join(', ');
  }
}

async function parseStudentFile(file) {
  const text   = await file.text();
  const parsed = JSON.parse(text);

  // Verificar firma de integridad
  const storedSig = parsed._signature;
  parsed._integrity_ok = false;
  if (storedSig) {
    const valid = await verifySignature(parsed);
    parsed._integrity_ok = valid;
  }

  parsed._filename = file.name;
  parsed._filesize = file.size;
  parsed._loaded_at = new Date().toISOString();

  // Calcular métricas derivadas
  parsed._metrics = computeMetrics(parsed);
  parsed._alerts  = computeAlerts(parsed._metrics);

  return parsed;
}

function computeMetrics(project) {
  const tele    = project.telemetry?.summary || {};
  const sources = project.sources || [];
  const content = project.content || {};

  const wordCount = countWords(
    content.html ? stripHTML(content.html) : (content.text || '')
  );

  return {
    student_name:          project.metadata?.student_name || extractNameFromFilename(project._filename),
    doc_title:             project.metadata?.title || 'Sin título',
    created_at:            project.metadata?.created_at,
    last_saved:            project.metadata?.last_saved,
    total_sessions:        tele.total_sessions       || 0,
    total_days_active:     tele.total_days_active    || 0,
    total_words_typed:     tele.total_words_typed    || 0,
    total_chars_pasted:    tele.total_chars_pasted   || 0,
    manual_ratio:          tele.manual_ratio         || 0,
    sources_count:         sources.length,
    sources_with_screenshot: tele.sources_with_screenshot || sources.filter(s => s.screenshot_filename).length,
    sources_cited_in_text: tele.sources_cited_in_text || sources.filter(s => s.cited_in_text).length,
    word_count:            wordCount,
    integrity_ok:          project._integrity_ok,
  };
}

function computeAlerts(m) {
  const alerts = [];

  // Alerta crítica: pocas sesiones
  if (m.total_sessions <= 1) {
    alerts.push({ level: 'danger', message: 'Documento creado en 1 sesión o menos' });
  } else if (m.total_sessions <= 2) {
    alerts.push({ level: 'warning', message: 'Solo 2 sesiones de trabajo registradas' });
  }

  // Alerta crítica: poco texto manual
  if (m.manual_ratio < 0.40) {
    alerts.push({ level: 'danger', message: `Solo ${Math.round(m.manual_ratio * 100)}% texto escrito manualmente` });
  } else if (m.manual_ratio < 0.65) {
    alerts.push({ level: 'warning', message: `${Math.round(m.manual_ratio * 100)}% de escritura manual (bajo)` });
  }

  // Sin fuentes con captura
  if (m.sources_count > 0 && m.sources_with_screenshot === 0) {
    alerts.push({ level: 'danger', message: 'Ninguna fuente tiene captura de pantalla' });
  } else if (m.sources_count > 0 && m.sources_with_screenshot < m.sources_count / 2) {
    alerts.push({ level: 'warning', message: 'Menos de la mitad de fuentes tiene captura' });
  }

  // Sin fuentes registradas
  if (m.sources_count === 0) {
    alerts.push({ level: 'danger', message: 'No hay fuentes registradas' });
  }

  // Pocas días activos para el volumen de texto
  if (m.word_count > 1000 && m.total_days_active <= 1) {
    alerts.push({ level: 'warning', message: `${m.word_count} palabras en solo ${m.total_days_active} día(s)` });
  }

  // Integridad
  if (!m.integrity_ok) {
    alerts.push({ level: 'warning', message: 'Posible modificación manual del archivo JSON' });
  }

  return alerts;
}

function alertLevel(alerts) {
  if (alerts.some(a => a.level === 'danger'))  return 'danger';
  if (alerts.some(a => a.level === 'warning')) return 'warning';
  return 'ok';
}

/* ================================================================
   ESTADÍSTICAS DEL CURSO
   ================================================================ */

function renderCourseStats() {
  const metrics = Dash.students.map(s => s._metrics);
  const n = metrics.length;

  const avg = key => {
    const vals = metrics.map(m => m[key]).filter(v => typeof v === 'number');
    return vals.length ? (vals.reduce((a,b) => a+b,0) / vals.length) : 0;
  };

  const countAlerts = level => Dash.students.filter(s => alertLevel(s._alerts) === level).length;

  const stats = [
    { label: 'Estudiantes cargados',   value: n },
    { label: 'Sin alertas',            value: countAlerts('ok'),      color: 'var(--success)' },
    { label: 'Con alertas leves',      value: countAlerts('warning'), color: 'var(--warning)' },
    { label: 'Con alertas críticas',   value: countAlerts('danger'),  color: 'var(--danger)' },
    { label: 'Promedio % manual',      value: Math.round(avg('manual_ratio') * 100) + '%' },
    { label: 'Promedio sesiones',      value: avg('total_sessions').toFixed(1) },
    { label: 'Promedio fuentes',       value: avg('sources_count').toFixed(1) },
    { label: 'Promedio palabras',      value: Math.round(avg('word_count')) },
  ];

  const grid = document.getElementById('course-stats-grid');
  grid.innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-card-value" style="${s.color ? `color: ${s.color}` : ''}">${s.value}</div>
      <div class="stat-card-label">${s.label}</div>
    </div>
  `).join('');
}

/* ================================================================
   GRÁFICOS (Chart.js)
   ================================================================ */

function renderCharts() {
  const metrics = Dash.students.map(s => s._metrics);
  const names   = metrics.map(m => shortName(m.student_name));

  // Destruir gráficos anteriores si existen
  Object.values(Dash.charts).forEach(c => c.destroy());
  Dash.charts = {};

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#9ba3b8' : '#52596b';

  Chart.defaults.color  = textColor;
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size   = 11;

  // Gráfico 1: % manual vs paste
  const ctx1 = document.getElementById('chart-manual-vs-paste').getContext('2d');
  Dash.charts.manual = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: names,
      datasets: [
        {
          label: '% Manual',
          data: metrics.map(m => Math.round(m.manual_ratio * 100)),
          backgroundColor: 'rgba(74,108,247,0.75)',
          borderRadius: 4,
        },
        {
          label: '% Pegado (aprox.)',
          data: metrics.map(m => Math.round((1 - m.manual_ratio) * 100)),
          backgroundColor: 'rgba(229,57,53,0.55)',
          borderRadius: 4,
        }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' }, tooltip: { mode: 'index' } },
      scales: {
        x: { stacked: true, grid: { color: gridColor } },
        y: { stacked: true, max: 100, grid: { color: gridColor }, ticks: { callback: v => v + '%' } }
      }
    }
  });

  // Gráfico 2: Sesiones por estudiante
  const ctx2 = document.getElementById('chart-sessions').getContext('2d');
  Dash.charts.sessions = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: names,
      datasets: [{
        label: 'Sesiones',
        data: metrics.map(m => m.total_sessions),
        backgroundColor: 'rgba(16,185,129,0.75)',
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor } },
        y: { beginAtZero: true, grid: { color: gridColor } }
      }
    }
  });
}

/* ================================================================
   TABLA DE ESTUDIANTES
   ================================================================ */

function renderTable() {
  const search      = document.getElementById('dash-search').value.toLowerCase();
  const alertFilter = document.getElementById('dash-filter-alert').value;

  let data = Dash.students.filter(s => {
    const name = (s._metrics.student_name || '').toLowerCase();
    if (search && !name.includes(search)) return false;
    if (alertFilter && alertLevel(s._alerts) !== alertFilter) return false;
    return true;
  });

  // Ordenar
  data.sort((a, b) => {
    let va = a._metrics[Dash.sortCol];
    let vb = b._metrics[Dash.sortCol];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return Dash.sortAsc ? -1 : 1;
    if (va > vb) return Dash.sortAsc ? 1  : -1;
    return 0;
  });

  const tbody = document.getElementById('students-table-body');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 32px; color: var(--text-muted);">No se encontraron resultados.</td></tr>`;
    return;
  }

  data.forEach(student => {
    const m     = student._metrics;
    const level = alertLevel(student._alerts);
    const tr    = document.createElement('tr');

    tr.innerHTML = `
      <td>
        <div style="font-weight: 600;">${escapeHtml(m.student_name)}</div>
        <div class="text-sm text-muted" style="font-size: 0.73rem; margin-top: 1px;">${escapeHtml(m.doc_title)}</div>
      </td>
      <td><strong>${m.total_sessions}</strong></td>
      <td>${m.total_days_active}</td>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 50px; height: 6px; background: var(--border); border-radius: 99px; overflow: hidden;">
            <div style="height: 100%; width: ${Math.round(m.manual_ratio * 100)}%; background: ${ratioColor(m.manual_ratio)}; border-radius: 99px;"></div>
          </div>
          <span>${Math.round(m.manual_ratio * 100)}%</span>
        </div>
      </td>
      <td>${m.total_chars_pasted > 0 ? m.total_chars_pasted.toLocaleString() + ' car.' : '—'}</td>
      <td>${m.sources_count}</td>
      <td>${m.sources_with_screenshot} / ${m.sources_count}</td>
      <td>${m.word_count.toLocaleString()}</td>
      <td>
        ${level === 'ok'
          ? '<span class="alert-badge alert-ok">✓ Sin alertas</span>'
          : `<span class="alert-badge alert-${level}" title="${student._alerts.map(a => a.message).join('\n')}">
              ${level === 'danger' ? '⚠' : '!'} ${student._alerts.length} alerta(s)
             </span>`}
        ${!m.integrity_ok ? '<span class="alert-badge alert-warning" title="El JSON pudo haber sido modificado manualmente" style="margin-top: 3px; display: block;">⚠ JSON modificado</span>' : ''}
      </td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="showStudentDetail('${encodeURIComponent(student._filename)}')">
          Detalle
        </button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

/* ================================================================
   DETALLE DE ESTUDIANTE
   ================================================================ */

function showStudentDetail(encodedFilename) {
  const filename = decodeURIComponent(encodedFilename);
  const student  = Dash.students.find(s => s._filename === filename);
  if (!student) return;

  Dash.detailStudent = student;
  const m = student._metrics;

  document.getElementById('detail-student-name').textContent = m.student_name;
  document.getElementById('detail-doc-title').textContent    = m.doc_title;

  // Stats del detalle
  const detailStats = [
    { label: 'Palabras totales',    value: m.word_count.toLocaleString() },
    { label: 'Días de trabajo',     value: m.total_days_active },
    { label: 'Sesiones',            value: m.total_sessions },
    { label: 'Texto manual',        value: Math.round(m.manual_ratio * 100) + '%', color: ratioColor(m.manual_ratio) },
    { label: 'Fuentes registradas', value: m.sources_count },
    { label: 'Fuentes con captura', value: `${m.sources_with_screenshot}/${m.sources_count}` },
  ];

  document.getElementById('detail-stats-grid').innerHTML = detailStats.map(s => `
    <div class="stat-card">
      <div class="stat-card-value" style="${s.color ? `color: ${s.color}` : ''}">${s.value}</div>
      <div class="stat-card-label">${s.label}</div>
    </div>
  `).join('');

  // Alertas
  const alertsHTML = student._alerts.length > 0
    ? `<div style="margin-bottom: 16px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 8px;">Alertas detectadas</div>
        ${student._alerts.map(a => `
          <div style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; padding: 10px 12px; border-radius: 7px; background: var(--${a.level === 'danger' ? 'danger' : 'warning'}-light);">
            <span style="font-size: 0.9rem;">${a.level === 'danger' ? '⚠' : '!'}</span>
            <span class="text-sm" style="color: var(--${a.level === 'danger' ? 'danger' : 'warning'}); font-weight: 500;">${escapeHtml(a.message)}</span>
          </div>
        `).join('')}
      </div>`
    : `<div style="padding: 12px; background: var(--success-light); border-radius: 7px; color: var(--success); font-size: 0.85rem; margin-bottom: 16px; font-weight: 500;">✓ Sin alertas. El estudiante presenta indicadores de trabajo genuino.</div>`;

  // Fuentes
  const sourcesHTML = (student.sources || []).length > 0
    ? `<div style="margin-top: 16px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px;">Fuentes registradas (${student.sources.length})</div>
        ${student.sources.map(src => `
          <div style="padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--bg-sidebar);">
            <div style="font-size: 0.83rem; font-weight: 600;">${escapeHtml(src.title || 'Sin título')}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap;">
              <span>${(src.authors || []).join('; ')}</span>
              <span>${src.year || '—'}</span>
              ${src.doi ? `<span>DOI: ${escapeHtml(src.doi)}</span>` : ''}
              <span style="color: ${src.screenshot_filename ? 'var(--success)' : 'var(--danger)'}">
                ${src.screenshot_filename ? '📸 Con captura' : '✗ Sin captura'}
              </span>
              <span style="color: ${src.cited_in_text ? 'var(--success)' : 'var(--text-muted)'}">
                ${src.cited_in_text ? '✓ Citado en texto' : 'Sin citar'}
              </span>
            </div>
          </div>
        `).join('')}
      </div>`
    : `<div class="text-sm text-muted" style="margin-top: 12px;">El estudiante no registró fuentes bibliográficas.</div>`;

  // Sesiones
  const sessions = student.telemetry?.sessions || [];
  const sessionsHTML = sessions.length > 0
    ? `<div style="margin-top: 16px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px;">Historial de sesiones</div>
        <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Fecha</th>
              <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Duración</th>
              <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Eventos de pegado</th>
            </tr>
          </thead>
          <tbody>
            ${sessions.map(s => `
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 10px;">${s.date ? new Date(s.date).toLocaleDateString('es') : '—'}</td>
                <td style="padding: 8px 10px;">${s.duration_minutes ? s.duration_minutes + ' min' : '—'}</td>
                <td style="padding: 8px 10px;">${(s.paste_events || []).length}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  document.getElementById('detail-tabs-content').innerHTML = alertsHTML + sourcesHTML + sessionsHTML;

  // Mostrar panel
  document.getElementById('student-detail').classList.remove('hidden');
  document.getElementById('student-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ================================================================
   EXPORTAR REPORTE CSV
   ================================================================ */

function exportCSV() {
  if (Dash.students.length === 0) {
    showToast('No hay datos cargados para exportar.', 'warning');
    return;
  }

  const headers = [
    'Estudiante', 'Título del documento', 'Sesiones', 'Días activos',
    '% Manual', 'Caracteres pegados', 'Fuentes totales', 'Fuentes con captura',
    'Fuentes citadas en texto', 'Total palabras', 'Nivel de alerta', 'Alertas', 'Integridad JSON'
  ];

  const rows = Dash.students.map(s => {
    const m = s._metrics;
    return [
      m.student_name,
      m.doc_title,
      m.total_sessions,
      m.total_days_active,
      Math.round(m.manual_ratio * 100) + '%',
      m.total_chars_pasted,
      m.sources_count,
      m.sources_with_screenshot,
      m.sources_cited_in_text,
      m.word_count,
      alertLevel(s._alerts),
      s._alerts.map(a => a.message).join(' | '),
      m.integrity_ok ? 'OK' : 'MODIFICADO',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`);
  });

  const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM para Excel
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `reporte_curso_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('Reporte CSV exportado.', 'success');
}

/* ================================================================
   FIRMA DE INTEGRIDAD (igual que en editor.js)
   ================================================================ */

async function verifySignature(payload) {
  const stored = payload._signature;
  if (!stored) return false;
  const clone = structuredClone(payload);
  delete clone._signature;
  const secret = 'EyeOnTheSky-v1-integrity';
  const data   = secret + JSON.stringify(clone);
  const msgBuf = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
  const expected = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
  return stored === expected;
}

/* ================================================================
   UTILIDADES
   ================================================================ */

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

function stripHTML(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

function shortName(name) {
  if (!name) return '—';
  const parts = name.split(' ');
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length-1]}` : name;
}

function extractNameFromFilename(filename) {
  return (filename || 'Estudiante').replace('.json','').replace(/_/g,' ');
}

function ratioColor(ratio) {
  if (ratio >= 0.75) return 'var(--success)';
  if (ratio >= 0.50) return 'var(--warning)';
  return 'var(--danger)';
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type} fade-in`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function restoreTheme() {
  const saved = localStorage.getItem('eots-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('eots-theme', theme);
  document.getElementById('dash-theme-icon-light').classList.toggle('hidden', theme === 'dark');
  document.getElementById('dash-theme-icon-dark').classList.toggle('hidden', theme === 'light');
  // Regenerar gráficos con nuevo tema si hay datos
  if (Dash.students.length > 0) renderCharts();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'light' ? 'dark' : 'light');
}
