// ===== DASHBOARD CHARTS (pure CSS bar charts, no external libs) =====

function loadDashCharts() {
  if (myRole !== 'admin') return;

  var chartsEl = document.getElementById('dashCharts');
  if (chartsEl) chartsEl.style.display = '';

  waFetch('/api/call-analytics')
    .then(function(data) {
      renderHourlyChart(data.hourly, data.answeredHourly, data.missedHourly);
      renderDailyChart(data.dailyTrend);
      renderAgentChart(data.agentComparison);
    })
    .catch(function() {});
}

// ===== HOURLY BAR CHART =====
function renderHourlyChart(hourly, answered, missed) {
  var el = document.getElementById('chartHourly');
  if (!el) return;

  var max = Math.max.apply(null, hourly) || 1;

  el.innerHTML = hourly.map(function(count, hour) {
    var h = Math.max(2, Math.round((count / max) * 100));
    var answeredH = count > 0 ? Math.round((answered[hour] / count) * h) : 0;
    var missedH = count > 0 ? Math.round((missed[hour] / count) * h) : 0;
    var otherH = h - answeredH - missedH;

    var tooltip = hour + ':00 — ' + count + ' call' + (count !== 1 ? 's' : '');
    if (answered[hour]) tooltip += ' (' + answered[hour] + ' answered)';
    if (missed[hour]) tooltip += ' (' + missed[hour] + ' missed)';

    return '<div title="' + tooltip + '" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;min-width:0;">' +
      (otherH > 0 ? '<div style="height:' + otherH + '%;background:#3498db;border-radius:2px 2px 0 0;min-height:0;"></div>' : '') +
      (answeredH > 0 ? '<div style="height:' + answeredH + '%;background:#2ecc71;min-height:0;"></div>' : '') +
      (missedH > 0 ? '<div style="height:' + missedH + '%;background:#e74c3c;border-radius:0 0 2px 2px;min-height:0;"></div>' : '') +
      (count === 0 ? '<div style="height:2px;background:#eee;border-radius:2px;"></div>' : '') +
    '</div>';
  }).join('');
}

// ===== DAILY TREND CHART =====
function renderDailyChart(dailyTrend) {
  var el = document.getElementById('chartDaily');
  if (!el) return;

  if (!dailyTrend || dailyTrend.length === 0) {
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ccc;font-size:13px;">No data for the last 7 days</div>';
    return;
  }

  var max = 1;
  dailyTrend.forEach(function(d) { if (d.total > max) max = d.total; });

  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  el.innerHTML = dailyTrend.map(function(d) {
    var h = Math.max(4, Math.round((d.total / max) * 100));
    var dayObj = new Date(d.day + 'T12:00:00');
    var dayName = days[dayObj.getDay()];
    var answeredPct = d.total > 0 ? Math.round((d.answered / d.total) * h) : 0;
    var missedPct = d.total > 0 ? Math.round((d.missed / d.total) * h) : 0;

    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;min-width:0;">' +
      '<div style="flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;">' +
        '<div style="font-size:10px;color:#888;margin-bottom:2px;">' + d.total + '</div>' +
        '<div style="width:70%;display:flex;flex-direction:column;">' +
          (answeredPct > 0 ? '<div style="height:' + answeredPct + 'px;background:#2ecc71;border-radius:3px 3px 0 0;"></div>' : '') +
          (missedPct > 0 ? '<div style="height:' + missedPct + 'px;background:#e74c3c;border-radius:0 0 3px 3px;"></div>' : '') +
        '</div>' +
      '</div>' +
      '<div style="font-size:10px;color:#999;margin-top:4px;">' + dayName + '</div>' +
    '</div>';
  }).join('');
}

// ===== AGENT COMPARISON CHART =====
function renderAgentChart(agentComp) {
  var el = document.getElementById('chartAgents');
  if (!el) return;

  if (!agentComp || agentComp.length === 0) {
    el.innerHTML = '<div style="color:#ccc;font-size:13px;">No agent call data this week</div>';
    return;
  }

  var maxTotal = 1;
  agentComp.forEach(function(a) { if (a.total > maxTotal) maxTotal = a.total; });

  el.innerHTML = agentComp.map(function(a) {
    var answeredW = Math.round((a.answered / maxTotal) * 100);
    var missedW = Math.round((a.missed / maxTotal) * 100);
    var talkStr = formatCallDuration(a.talkTime);

    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
      '<div style="width:70px;font-size:12px;font-weight:600;color:#222;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(a.agent) + '</div>' +
      '<div style="flex:1;display:flex;height:20px;background:#f5f5f5;border-radius:4px;overflow:hidden;">' +
        (answeredW > 0 ? '<div style="width:' + answeredW + '%;background:#2ecc71;" title="' + a.answered + ' answered"></div>' : '') +
        (missedW > 0 ? '<div style="width:' + missedW + '%;background:#e74c3c;" title="' + a.missed + ' missed"></div>' : '') +
      '</div>' +
      '<div style="width:80px;font-size:11px;color:#888;text-align:right;">' + a.total + ' calls</div>' +
      '<div style="width:60px;font-size:11px;color:#888;text-align:right;">' + talkStr + '</div>' +
    '</div>';
  }).join('') +
  '<div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:#999;">' +
    '<span><span style="display:inline-block;width:10px;height:10px;background:#2ecc71;border-radius:2px;margin-right:4px;"></span>Answered</span>' +
    '<span><span style="display:inline-block;width:10px;height:10px;background:#e74c3c;border-radius:2px;margin-right:4px;"></span>Missed</span>' +
  '</div>';
}
