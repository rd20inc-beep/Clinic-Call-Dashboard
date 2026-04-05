// ===== PATIENT PROFILE MODAL =====

function openProfile(phone, clinicaUrl) {
  profileModal.classList.add('active');
  modalClinicaLink.href = clinicaUrl || '#';
  modalTitle.textContent = 'Patient Profile';
  modalBody.innerHTML = '<div class="modal-loading"><div class="spinner"></div><p>Loading patient profile...</p></div>';
  modalTabs.querySelectorAll('.modal-tab').forEach(function(t, i) { t.classList.toggle('active', i === 0); });

  fetch('/api/patient-profile/' + encodeURIComponent(phone))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        modalBody.innerHTML = '<div class="modal-error">' + escapeHtml(data.error) + '</div>';
        return;
      }
      profileData = data;
      modalTitle.textContent = data.patientName || 'Patient Profile';
      if (data.patientID) {
        modalClinicaLink.href = modalClinicaLink.href || '#';
      }
      updateTabCounts();
      renderOverview();
    })
    .catch(function(err) {
      modalBody.innerHTML = '<div class="modal-error">Failed to load profile: ' + escapeHtml(err.message) + '</div>';
    });
}

function openProfileById(patientId, patientName) {
  profileModal.classList.add('active');
  modalClinicaLink.href = '#';
  modalTitle.textContent = patientName || 'Patient Profile';
  modalTabs.querySelectorAll('.modal-tab').forEach(function(t, i) { t.classList.toggle('active', i === 0); });

  if (String(patientId).indexOf('local-') === 0) {
    modalBody.innerHTML = '<div class="modal-error">This patient exists only in the local database and has no Clinicea profile yet.</div>';
    return;
  }

  modalBody.innerHTML = '<div class="modal-loading"><div class="spinner"></div><p>Loading patient profile...</p></div>';

  fetch('/api/patient-profile-by-id/' + encodeURIComponent(patientId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        modalBody.innerHTML = '<div class="modal-error">' + escapeHtml(data.error) + '</div>';
        return;
      }
      profileData = data;
      modalTitle.textContent = data.patientName || patientName || 'Patient Profile';
      updateTabCounts();
      renderOverview();
    })
    .catch(function(err) {
      modalBody.innerHTML = '<div class="modal-error">Failed to load profile: ' + escapeHtml(err.message) + '</div>';
    });
}

function closeProfile() {
  profileModal.classList.remove('active');
  profileData = null;
}

document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeProfile(); });

function switchTab(tab) {
  modalTabs.querySelectorAll('.modal-tab').forEach(function(t) {
    t.classList.toggle('active', t.textContent.toLowerCase().includes(tab));
  });
  if (!profileData) return;
  if (tab === 'overview') renderOverview();
  else if (tab === 'appointments') renderAppointments();
  else if (tab === 'bills') renderBills();
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').filter(function(w) { return w.length > 0; }).map(function(w) { return w[0]; }).join('').toUpperCase().substring(0, 2);
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatTime(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatCurrency(amount) {
  var num = parseFloat(amount) || 0;
  return 'PKR ' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function infoRow(label, value) {
  if (!value && value !== 0) return '';
  return '<div class="info-row"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-value">' + escapeHtml(String(value)) + '</span></div>';
}

function updateTabCounts() {
  if (!profileData) return;
  var aptCount = document.getElementById('tabCountApt');
  var billCount = document.getElementById('tabCountBills');
  if (aptCount) aptCount.textContent = profileData.appointments ? profileData.appointments.length : 0;
  if (billCount) billCount.textContent = profileData.bills ? profileData.bills.length : 0;
}

function getAptStatusClass(status) {
  var sl = (status || '').toLowerCase();
  if (sl.includes('complet') || sl.includes('checked') || sl.includes('arrived')) return 'completed';
  if (sl.includes('cancel')) return 'cancelled';
  if (sl.includes('no show') || sl.includes('noshow')) return 'noshow';
  return 'upcoming';
}

function buildDonutChart(data, total) {
  // data = [{label, value, color}]
  var size = 130, cx = 65, cy = 65, r = 50, strokeW = 14;
  var circumference = 2 * Math.PI * r;
  var offset = 0;
  var paths = '';
  data.forEach(function(d) {
    var pct = total > 0 ? d.value / total : 0;
    var dashLen = pct * circumference;
    paths += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + d.color + '" stroke-width="' + strokeW + '" stroke-dasharray="' + dashLen + ' ' + (circumference - dashLen) + '" stroke-dashoffset="' + (-offset) + '" stroke-linecap="round" style="transition:stroke-dasharray 0.6s ease"/>';
    offset += dashLen;
  });
  if (total === 0) {
    paths = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#e9ecef" stroke-width="' + strokeW + '"/>';
  }
  var svg = '<svg class="donut-svg" viewBox="0 0 ' + size + ' ' + size + '">';
  svg += '<g transform="rotate(-90 ' + cx + ' ' + cy + ')">' + paths + '</g>';
  svg += '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" class="donut-center-text">' + total + '</text>';
  svg += '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" class="donut-center-label">Total</text>';
  svg += '</svg>';
  // Legend
  svg += '<div class="donut-legend">';
  data.forEach(function(d) {
    svg += '<div class="donut-legend-item"><span class="donut-legend-dot" style="background:' + d.color + '"></span>' + d.label + ' (' + d.value + ')</div>';
  });
  svg += '</div>';
  return svg;
}

function renderOverview() {
  var p = profileData.patient || {};
  var pat = Array.isArray(p) ? (p[0] || {}) : p;

  var name = pat.Name || pat.PatientName || profileData.patientName ||
             [pat.FirstName, pat.LastName].filter(Boolean).join(' ') || 'Unknown';
  var initials = getInitials(name);
  var mobile = pat.Mobile || pat.MobilePhone || pat.PatientMobile || '';
  var email = pat.Email || pat.EmailAddress || '';

  var dob = pat.DOB || pat.DateOfBirth || '';
  var age = '';
  if (dob) {
    var bd = new Date(dob);
    if (!isNaN(bd)) {
      age = String(Math.floor((Date.now() - bd.getTime()) / (365.25 * 24 * 60 * 60 * 1000)));
    }
  }

  var dueAmount = parseFloat(pat.BillDueAmount) || 0;
  var totalApts = profileData.appointments ? profileData.appointments.length : 0;
  var totalBills = profileData.bills ? profileData.bills.length : 0;
  var sinceDate = pat.CreatedDatetime || pat.CreatedDate || pat.RegistrationDate || '';

  // Count appointment statuses
  var completedApts = 0, upcomingApts = 0, cancelledApts = 0, noshowApts = 0;
  (profileData.appointments || []).forEach(function(a) {
    var sc = getAptStatusClass(a.AppointmentStatus || a.Status);
    if (sc === 'completed') completedApts++;
    else if (sc === 'cancelled') cancelledApts++;
    else if (sc === 'noshow') noshowApts++;
    else upcomingApts++;
  });

  // Calculate bill totals
  var totalBilled = 0, totalDue = 0;
  (profileData.bills || []).forEach(function(b) {
    totalBilled += parseFloat(b.TotalAmount || b.GrossAmount || b.Amount || 0);
    totalDue += parseFloat(b.DueAmount || b.BalanceDue || 0);
  });
  var totalPaid = totalBilled - totalDue;

  // --- Build HTML ---
  // Hero card
  var tags = '';
  if (pat.Gender) tags += '<span class="patient-tag gender"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> ' + escapeHtml(pat.Gender) + '</span>';
  if (pat.FileNo) tags += '<span class="patient-tag file"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> #' + escapeHtml(pat.FileNo) + '</span>';
  if (age) tags += '<span class="patient-tag age-tag">' + escapeHtml(age) + ' yrs</span>';
  if (pat.BloodGroup) tags += '<span class="patient-tag blood"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg> ' + escapeHtml(pat.BloodGroup) + '</span>';
  if (dueAmount > 0) {
    tags += '<span class="patient-tag due">Due: ' + escapeHtml(formatCurrency(dueAmount)) + '</span>';
  } else {
    tags += '<span class="patient-tag paid">No Dues</span>';
  }
  if (sinceDate) tags += '<span class="patient-tag since">Since ' + escapeHtml(formatDate(sinceDate)) + '</span>';

  var html = '<div class="patient-hero">';
  html += '<div class="patient-avatar">' + escapeHtml(initials) + '</div>';
  html += '<div class="patient-hero-info">';
  html += '<h3>' + escapeHtml(name) + '</h3>';
  html += '<div class="hero-subtitle">';
  if (mobile) html += '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg> ' + escapeHtml(mobile) + '</span>';
  if (mobile && email) html += '<span class="hero-divider">|</span>';
  if (email) html += '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ' + escapeHtml(email) + '</span>';
  if (!mobile && !email) html += '<span>No contact info</span>';
  html += '</div>';
  html += '<div class="patient-tags">' + tags + '</div>';
  html += '</div>';
  html += '<div class="patient-hero-stats">';
  html += '<div class="hero-stat"><div class="hero-stat-value">' + totalApts + '</div><div class="hero-stat-label">Visits</div></div>';
  html += '<div class="hero-stat"><div class="hero-stat-value">' + totalBills + '</div><div class="hero-stat-label">Bills</div></div>';
  html += '</div>';
  html += '</div>';

  // Quick stat cards
  html += '<div class="quick-stats">';
  html += '<div class="quick-stat-card"><div class="quick-stat-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div><div class="quick-stat-text"><div class="quick-stat-value">' + completedApts + '</div><div class="quick-stat-label">Completed</div></div></div>';
  html += '<div class="quick-stat-card"><div class="quick-stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="quick-stat-text"><div class="quick-stat-value">' + upcomingApts + '</div><div class="quick-stat-label">Upcoming</div></div></div>';
  html += '<div class="quick-stat-card"><div class="quick-stat-icon purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="quick-stat-text"><div class="quick-stat-value">' + escapeHtml(formatCurrency(totalBilled)) + '</div><div class="quick-stat-label">Total Billed</div></div></div>';
  html += '<div class="quick-stat-card"><div class="quick-stat-icon ' + (totalDue > 0 ? 'red' : 'green') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg></div><div class="quick-stat-text"><div class="quick-stat-value">' + escapeHtml(formatCurrency(totalDue)) + '</div><div class="quick-stat-label">Outstanding</div></div></div>';
  html += '</div>';

  // Chart + finance section
  html += '<div class="chart-section">';
  // Donut chart
  var donutData = [];
  if (completedApts > 0) donutData.push({ label: 'Completed', value: completedApts, color: '#2e7d32' });
  if (upcomingApts > 0) donutData.push({ label: 'Upcoming', value: upcomingApts, color: '#1565c0' });
  if (cancelledApts > 0) donutData.push({ label: 'Cancelled', value: cancelledApts, color: '#bdbdbd' });
  if (noshowApts > 0) donutData.push({ label: 'No-show', value: noshowApts, color: '#e65100' });
  html += '<div class="donut-chart-card"><h4>Appointment Breakdown</h4>' + buildDonutChart(donutData, totalApts) + '</div>';

  // Finance overview
  var paidPct = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 100;
  html += '<div class="finance-overview">';
  html += '<h4>Financial Summary</h4>';
  html += '<div class="finance-stat-row">';
  html += '<div class="finance-stat billed"><div class="finance-stat-value">' + escapeHtml(formatCurrency(totalBilled)) + '</div><div class="finance-stat-label">Total Billed</div></div>';
  html += '<div class="finance-stat paid"><div class="finance-stat-value">' + escapeHtml(formatCurrency(totalPaid)) + '</div><div class="finance-stat-label">Paid</div></div>';
  html += '<div class="finance-stat due"><div class="finance-stat-value">' + escapeHtml(formatCurrency(totalDue)) + '</div><div class="finance-stat-label">Outstanding</div></div>';
  html += '</div>';
  html += '<div class="progress-bar-container"><div class="progress-bar-fill" style="width:' + paidPct + '%"></div></div>';
  html += '<div class="progress-bar-label">' + paidPct + '% paid</div>';
  html += '</div>';
  html += '</div>';

  // Info cards grid
  html += '<div class="info-grid">';

  html += '<div class="info-card"><div class="info-card-header"><div class="info-card-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div><h4>Personal Information</h4></div>';
  html += infoRow('Full Name', name);
  html += infoRow('Date of Birth', formatDate(dob));
  html += infoRow('Age', age ? age + ' years' : '');
  html += infoRow('Gender', pat.Gender);
  html += infoRow('Marital Status', pat.MaritalStatus);
  html += infoRow('Nationality', pat.Nationality);
  html += infoRow('File No', pat.FileNo);
  html += '</div>';

  html += '<div class="info-card"><div class="info-card-header"><div class="info-card-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></div><h4>Contact Information</h4></div>';
  html += infoRow('Mobile', mobile);
  html += infoRow('Email', email);
  html += infoRow('Phone', pat.Phone || pat.HomePhone);
  html += infoRow('Address', [pat.Address1, pat.Address2].filter(Boolean).join(', '));
  html += infoRow('City', pat.City);
  html += infoRow('State', pat.State);
  html += infoRow('Country', pat.Country);
  html += infoRow('Postal Code', pat.PostalCode || pat.ZipCode);
  html += '</div>';

  html += '<div class="info-card"><div class="info-card-header"><div class="info-card-icon red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><h4>Medical Information</h4></div>';
  html += infoRow('Blood Group', pat.BloodGroup);
  html += infoRow('Allergies', pat.Allergies);
  html += infoRow('Medical History', pat.MedicalHistory);
  html += infoRow('Notes', pat.Notes || pat.PatientNotes);
  html += infoRow('Referring Doctor', pat.ReferringDoctor || pat.ReferredBy);
  html += infoRow('Primary Doctor', pat.PrimaryDoctor || pat.DoctorName);
  html += '</div>';

  html += '<div class="info-card"><div class="info-card-header"><div class="info-card-icon teal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg></div><h4>Account Details</h4></div>';
  html += infoRow('Total Due', dueAmount > 0 ? formatCurrency(dueAmount) : 'None');
  html += infoRow('Total Appointments', String(totalApts));
  html += infoRow('Total Bills', String(totalBills));
  html += infoRow('Patient Since', formatDate(sinceDate));
  html += infoRow('Patient ID', profileData.patientID);
  html += '</div>';

  html += '</div>';
  modalBody.innerHTML = html;
}

function renderAppointments(filterDate, filterStatus) {
  var apts = profileData.appointments;
  if (!apts || apts.length === 0) {
    modalBody.innerHTML = '<div class="empty-tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><p>No appointments found</p></div>';
    return;
  }

  // Preserve current filter values if not explicitly passed
  if (typeof filterDate === 'undefined') {
    var existingDate = document.getElementById('aptDateFilter');
    filterDate = existingDate ? existingDate.value : '';
  }
  if (typeof filterStatus === 'undefined') {
    var existingStatus = document.getElementById('aptStatusFilter');
    filterStatus = existingStatus ? existingStatus.value : 'all';
  }

  // Count statuses (from full list, not filtered)
  var completed = 0, upcoming = 0, cancelled = 0, noshow = 0;
  apts.forEach(function(a) {
    var sc = getAptStatusClass(a.AppointmentStatus || a.Status);
    if (sc === 'completed') completed++;
    else if (sc === 'cancelled') cancelled++;
    else if (sc === 'noshow') noshow++;
    else upcoming++;
  });

  // Apply filters
  var filtered = apts;
  if (filterDate) {
    filtered = filtered.filter(function(a) {
      var d = new Date(a.StartDateTime || a.AppointmentDateTime || '');
      if (isNaN(d)) return false;
      var aptDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      return aptDate === filterDate;
    });
  }
  if (filterStatus && filterStatus !== 'all') {
    filtered = filtered.filter(function(a) {
      return getAptStatusClass(a.AppointmentStatus || a.Status) === filterStatus;
    });
  }

  var html = '';

  // Date picker + status filter toolbar
  html += '<div class="apt-toolbar">';
  html += '<div class="apt-toolbar-row">';
  html += '<input type="date" id="aptDateFilter" value="' + escapeHtml(filterDate || '') + '" onchange="renderAppointments(this.value)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;color:#334155;">';
  html += '<select id="aptStatusFilter" onchange="renderAppointments(undefined, this.value)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;color:#334155;">';
  html += '<option value="all"' + (filterStatus === 'all' ? ' selected' : '') + '>All Status</option>';
  html += '<option value="completed"' + (filterStatus === 'completed' ? ' selected' : '') + '>Completed</option>';
  html += '<option value="upcoming"' + (filterStatus === 'upcoming' ? ' selected' : '') + '>Upcoming</option>';
  html += '<option value="cancelled"' + (filterStatus === 'cancelled' ? ' selected' : '') + '>Cancelled</option>';
  html += '<option value="noshow"' + (filterStatus === 'noshow' ? ' selected' : '') + '>No-show</option>';
  html += '</select>';
  if (filterDate || (filterStatus && filterStatus !== 'all')) {
    html += '<button onclick="renderAppointments(\'\', \'all\')" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#f8fafc;color:#64748b;cursor:pointer;">Clear</button>';
  }
  html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto;">' + filtered.length + ' of ' + apts.length + ' appointments</span>';
  html += '</div>';
  html += '</div>';

  // Summary cards
  html += '<div class="apt-summary">';
  html += '<div class="apt-summary-card total" style="cursor:pointer;" onclick="renderAppointments(\'\', \'all\')"><div class="apt-summary-value">' + apts.length + '</div><div class="apt-summary-label">Total</div></div>';
  html += '<div class="apt-summary-card done" style="cursor:pointer;" onclick="renderAppointments(undefined, \'completed\')"><div class="apt-summary-value">' + completed + '</div><div class="apt-summary-label">Completed</div></div>';
  html += '<div class="apt-summary-card upcoming-s" style="cursor:pointer;" onclick="renderAppointments(undefined, \'upcoming\')"><div class="apt-summary-value">' + upcoming + '</div><div class="apt-summary-label">Upcoming</div></div>';
  html += '<div class="apt-summary-card missed" style="cursor:pointer;" onclick="renderAppointments(undefined, \'cancelled\')"><div class="apt-summary-value">' + (noshow + cancelled) + '</div><div class="apt-summary-label">Missed/Cancelled</div></div>';
  html += '</div>';

  if (filtered.length === 0) {
    html += '<div class="empty-tab" style="padding:30px 0;"><p>No appointments match the selected filters</p></div>';
    modalBody.innerHTML = html;
    return;
  }

  var sorted = filtered.slice().sort(function(a, b) { return new Date(b.StartDateTime || b.AppointmentDateTime || 0) - new Date(a.StartDateTime || a.AppointmentDateTime || 0); });

  // Group by date
  var groups = {};
  sorted.forEach(function(apt) {
    var d = new Date(apt.StartDateTime || apt.AppointmentDateTime || '');
    var key = isNaN(d) ? 'Unknown Date' : d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    if (!groups[key]) groups[key] = [];
    groups[key].push(apt);
  });

  html += '<div class="apt-list">';
  Object.keys(groups).forEach(function(dateLabel) {
    html += '<div class="apt-date-header">' + escapeHtml(dateLabel) + ' <span style="color:#94a3b8;font-weight:400;">(' + groups[dateLabel].length + ')</span></div>';
    groups[dateLabel].forEach(function(apt) {
      var dateStr = apt.StartDateTime || apt.AppointmentDateTime || '';
      var status = apt.AppointmentStatus || apt.Status || 'Unknown';
      var service = apt.ServiceName || apt.Service || '';
      var doctor = apt.DoctorName || apt.Doctor || '';
      var duration = apt.Duration ? apt.Duration + ' min' : '';
      var statusClass = getAptStatusClass(status);

      html += '<div class="apt-item ' + statusClass + '">';
      html += '<div class="apt-item-left">';
      html += '<h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ' + escapeHtml(service || 'Appointment') + '</h4>';
      html += '<p>' + escapeHtml(formatTime(dateStr)) + '</p>';
      html += '<div class="apt-meta">';
      if (doctor) html += '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> ' + escapeHtml(doctor) + '</span>';
      if (duration) html += '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ' + escapeHtml(duration) + '</span>';
      html += '</div>';
      html += '</div>';
      html += '<span class="apt-status ' + statusClass + '">' + escapeHtml(status) + '</span>';
      html += '</div>';
    });
  });
  html += '</div>';
  modalBody.innerHTML = html;
}

function renderBills() {
  var bills = profileData.bills;
  if (!bills || bills.length === 0) {
    modalBody.innerHTML = '<div class="empty-tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>No bills found</p></div>';
    return;
  }

  // Calculate totals
  var totalBilled = 0, totalDue = 0;
  bills.forEach(function(b) {
    totalBilled += parseFloat(b.TotalAmount || b.GrossAmount || b.Amount || 0);
    totalDue += parseFloat(b.DueAmount || b.BalanceDue || 0);
  });
  var totalPaid = totalBilled - totalDue;
  var paidPct = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 100;

  var html = '';
  // Finance summary at top
  html += '<div class="finance-stat-row" style="margin-bottom:20px">';
  html += '<div class="finance-stat billed" style="border-radius:12px;padding:16px"><div class="finance-stat-value">' + escapeHtml(formatCurrency(totalBilled)) + '</div><div class="finance-stat-label">Total Billed</div></div>';
  html += '<div class="finance-stat paid" style="border-radius:12px;padding:16px"><div class="finance-stat-value">' + escapeHtml(formatCurrency(totalPaid)) + '</div><div class="finance-stat-label">Paid</div></div>';
  html += '<div class="finance-stat due" style="border-radius:12px;padding:16px"><div class="finance-stat-value">' + escapeHtml(formatCurrency(totalDue)) + '</div><div class="finance-stat-label">Outstanding</div></div>';
  html += '</div>';
  html += '<div style="margin-bottom:20px"><div class="progress-bar-container"><div class="progress-bar-fill" style="width:' + paidPct + '%"></div></div><div class="progress-bar-label">' + paidPct + '% collected</div></div>';

  var sorted = bills.slice().sort(function(a, b) { return new Date(b.BillDate || b.CreatedDate || 0) - new Date(a.BillDate || a.CreatedDate || 0); });

  html += '<div class="apt-list">';
  sorted.forEach(function(bill) {
    var dateStr = bill.BillDate || bill.CreatedDate || '';
    var billNo = bill.BillNo || bill.BillNumber || bill.InvoiceNo || '';
    var total = parseFloat(bill.TotalAmount || bill.GrossAmount || bill.Amount || 0);
    var due = parseFloat(bill.DueAmount || bill.BalanceDue || 0);
    var paid = total - due;
    var status = bill.BillStatus || bill.Status || '';
    var items = bill.ServiceName || bill.Description || bill.Items || '';
    var billPaidPct = total > 0 ? Math.round((paid / total) * 100) : 100;

    html += '<div class="bill-card">';
    html += '<div class="bill-left">';
    html += '<h4>' + escapeHtml(items || ('Bill #' + (billNo || '\u2014'))) + '</h4>';
    html += '<p>' + escapeHtml(formatDate(dateStr));
    if (billNo) html += ' &middot; #' + escapeHtml(billNo);
    if (status) html += ' &middot; ' + escapeHtml(status);
    html += '</p></div>';
    html += '<div class="bill-right">';
    html += '<div class="bill-amount">' + escapeHtml(formatCurrency(total)) + '</div>';
    if (due > 0) {
      html += '<div class="bill-due-badge">Due: ' + escapeHtml(formatCurrency(due)) + '</div>';
    } else {
      html += '<div class="bill-paid-badge">Paid</div>';
    }
    html += '<div class="bill-progress"><div class="bill-progress-fill" style="width:' + billPaidPct + '%"></div></div>';
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  modalBody.innerHTML = html;
}
