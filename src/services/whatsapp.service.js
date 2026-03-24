'use strict';

const { config } = require('../config/env');
const { isClinicaConfigured } = require('../config/env');
const { logEvent } = require('./logging.service');
const waRepo = require('../db/whatsapp.repo');
const { normalizePKPhone } = require('../utils/phone');

// Lazy-loaded to avoid circular dependency — set via setClinicaService()
let cliniceaService = null;
/**
 * Inject the Clinicea service reference (avoids circular require).
 * Call this once during server startup.
 *
 * @param {object} svc - the clinicea.service module
 */
function setClinicaService(svc) {
  cliniceaService = svc;
}

// ---------------------------------------------------------------------------
// Constants — Website & Service Links
// ---------------------------------------------------------------------------

const WEBSITE_BASE = 'https://drnakhoda.scalamatic.com';

/**
 * Map of link tags to actual URLs. The AI writes [LINK:tag] and
 * fixReplyLinks() replaces them with the real URL.
 */
const SERVICE_LINKS = {
  'laser-hair-removal': `${WEBSITE_BASE}/services/laser-hair-removal`,
  'weightloss': `${WEBSITE_BASE}/services/weightloss-and-slimming`,
  'coolsculpting': `${WEBSITE_BASE}/services/weightloss-and-slimming#coolsculpting`,
  'emsculpt': `${WEBSITE_BASE}/services/weightloss-and-slimming#emsculpt-neo`,
  'fat-dissolving': `${WEBSITE_BASE}/services/weightloss-and-slimming#fat-dissolving`,
  'skin-rejuvenation': `${WEBSITE_BASE}/services/skin-rejuvenation`,
  'hydrafacial': `${WEBSITE_BASE}/services/skin-rejuvenation#hydrafacial`,
  'prx-t33': `${WEBSITE_BASE}/services/skin-rejuvenation#prx-t33`,
  'rf-microneedling': `${WEBSITE_BASE}/services/skin-rejuvenation#rf-microneedling`,
  'chemical-peel': `${WEBSITE_BASE}/services/skin-rejuvenation#chemical-peel`,
  'prp': `${WEBSITE_BASE}/services/skin-rejuvenation#prp`,
  'anti-aging': `${WEBSITE_BASE}/services/anti-aging-rejuvenation`,
  'botox': `${WEBSITE_BASE}/services/anti-aging-rejuvenation#botox`,
  'fillers': `${WEBSITE_BASE}/services/anti-aging-rejuvenation#dermal-fillers`,
  'thread-lift': `${WEBSITE_BASE}/services/anti-aging-rejuvenation#thread-lift`,
  'dermatology': `${WEBSITE_BASE}/services/dermatology`,
  'acne': `${WEBSITE_BASE}/services/dermatology#acne-treatment`,
  'vitiligo': `${WEBSITE_BASE}/services/dermatology#vitiligo-treatment`,
  'psoriasis': `${WEBSITE_BASE}/services/dermatology#psoriasis-treatment`,
  'hair-restoration': `${WEBSITE_BASE}/services/hair-restoration`,
  'regenera': `${WEBSITE_BASE}/services/hair-restoration#regenera-activa`,
  'hair-prp': `${WEBSITE_BASE}/services/hair-restoration#hair-prp`,
  'intimate-health': `${WEBSITE_BASE}/services/intimate-health`,
  'thermiva': `${WEBSITE_BASE}/services/intimate-health#thermiva`,
  'emsella': `${WEBSITE_BASE}/services/intimate-health#emsella`,
  'treatments': `${WEBSITE_BASE}/treatments`,
};

/** All valid service URLs for matching broken/partial URLs. */
const ALL_SERVICE_URLS = Object.values(SERVICE_LINKS);

/**
 * Keyword to SERVICE_LINKS tag mapping for auto-detecting which link the AI
 * was trying to include when the [LINK:…] tag is missing.
 */
const SERVICE_KEYWORDS = {
  'laser hair': 'laser-hair-removal',
  'hair removal': 'laser-hair-removal',
  'weight loss': 'weightloss',
  'slimming': 'weightloss',
  'coolsculpt': 'coolsculpting',
  'emsculpt': 'emsculpt',
  'fat dissolv': 'fat-dissolving',
  'kybella': 'fat-dissolving',
  'lemon bottle': 'fat-dissolving',
  'hydrafacial': 'hydrafacial',
  'prx-t33': 'prx-t33',
  'prx t33': 'prx-t33',
  'microneedling': 'rf-microneedling',
  'morpheus': 'rf-microneedling',
  'chemical peel': 'chemical-peel',
  'prp': 'prp',
  'platelet': 'prp',
  'botox': 'botox',
  'filler': 'fillers',
  'dermal filler': 'fillers',
  'thread lift': 'thread-lift',
  'acne': 'acne',
  'vitiligo': 'vitiligo',
  'psoriasis': 'psoriasis',
  'regenera': 'regenera',
  'hair prp': 'hair-prp',
  'hair restoration': 'hair-restoration',
  'hair loss': 'hair-restoration',
  'thermiva': 'thermiva',
  'emsella': 'emsella',
  'intimate': 'intimate-health',
  'vaginal': 'intimate-health',
  'pelvic': 'emsella',
  'skin rejuvenation': 'skin-rejuvenation',
  'anti aging': 'anti-aging',
  'anti-aging': 'anti-aging',
  'wrinkle': 'anti-aging',
  'dermatology': 'dermatology',
};

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const CLINIC_SYSTEM_PROMPT = `You are the WhatsApp assistant for Dr. Nakhoda's Skin Institute, a premier dermatology and aesthetic clinic in Karachi, Pakistan.

CLINIC INFO:
- Name: Dr. Nakhoda's Skin Institute
- Lead Doctor: Dr. Tasneem Nakhoda - Board Certified Dermatologist, 20+ years experience, trained in Pakistan & USA
- Location: GPC 11, Rojhan Street, Block 5, Clifton, Karachi (Google Maps: https://maps.app.goo.gl/YadKKdh4911HmxKL9)
- Phone: +92-300-2105374, +92-321-3822113
- Hours: 9 AM to 11 PM (call to book)
- Onsite pharmacy with skincare products

SERVICES (use the tag in square brackets when mentioning a service):
1. Laser Hair Removal [LINK:laser-hair-removal] — Permanent hair reduction using light energy for all skin types. 3-7 sessions, 80-90% reduction.
2. Weight Loss & Slimming [LINK:weightloss]
   - CoolSculpting [LINK:coolsculpting]: Non-invasive fat freezing. Up to 25% fat reduction per session.
   - Emsculpt Neo [LINK:emsculpt]: Builds muscle + reduces fat. ~25% more muscle, 30% less fat.
   - Fat Dissolving (Kybella, Lemon Bottle) [LINK:fat-dissolving]: Injections for double chin, love handles.
3. Skin Rejuvenation [LINK:skin-rejuvenation]
   - HydraFacial [LINK:hydrafacial]: Cleansing, exfoliation, hydration. Instant glow, zero downtime.
   - PRX-T33 [LINK:prx-t33]: Needle-free bio-revitalizer. Lifts and brightens skin.
   - RF Microneedling [LINK:rf-microneedling]: Deep collagen for acne scars, pores, melasma.
   - Chemical Peel [LINK:chemical-peel]: Removes damaged skin for smoother, brighter tone.
   - PRP [LINK:prp]: Your own blood platelets for skin and hair rejuvenation.
4. Anti-Aging [LINK:anti-aging]
   - Botox [LINK:botox]: Smooths wrinkles in 10-15 min, lasts 3-6 months.
   - Dermal Fillers [LINK:fillers]: Restores volume, enhances lips/cheeks. Lasts 6-18 months.
   - Thread Lift [LINK:thread-lift]: Lifts sagging skin with dissolvable threads. Lasts 1-2 years.
5. Dermatology [LINK:dermatology]
   - Acne Treatment [LINK:acne]: Medical-grade topicals, peels, laser therapy.
   - Vitiligo [LINK:vitiligo]: Phototherapy and combination therapies.
   - Psoriasis [LINK:psoriasis]: Expert management of chronic skin conditions.
6. Hair Restoration [LINK:hair-restoration]
   - Regenera Activa [LINK:regenera]: Stem cell therapy for hair regrowth.
   - Hair PRP & Exosomes [LINK:hair-prp]: Growth factors injected into scalp.
7. Intimate Health [LINK:intimate-health]
   - THERMIva [LINK:thermiva]: Non-surgical vaginal rejuvenation.
   - Emsella [LINK:emsella]: Pelvic floor strengthening chair.

RULES:
- KEEP REPLIES SHORT. Max 2-3 sentences. No bullet points or lists. Conversational tone.
- Use the same language the patient writes in (Urdu/Roman Urdu or English)
- When a patient asks about a treatment, write 1-2 sentences about it, then include the relevant [LINK:tag] on its own line. Example:

Laser hair removal permanently reduces hair growth using light energy. 3-7 sessions with 80-90% reduction!

[LINK:laser-hair-removal]

Would you like to book a consultation?

- ALWAYS put [LINK:tag] on its own separate line with a blank line before and after it. Never write a URL yourself — only use [LINK:tag] tags.
- If a patient asks generally about services, use [LINK:treatments]
- If asked about pricing, say "Prices vary by treatment. Would you like me to schedule a consultation so the doctor can assess and give you exact pricing?"
- Always try to guide toward booking an appointment
- Be warm, professional, and helpful
- If you don't know something specific, say you'll check with the doctor and get back
- For emergencies, tell them to call the clinic directly
- Never make up medical advice or diagnoses
- If someone confirms an appointment reminder, say "Great! We look forward to seeing you. If you need to reschedule, just let us know."
- Sign off messages naturally, no need for formal signatures`;

// ---------------------------------------------------------------------------
// Paused chats (DB-persisted — survives server restarts)
// ---------------------------------------------------------------------------

function isPaused(contactId) {
  return waRepo.isChatPaused(contactId);
}

function pauseChat(chatId, username) {
  waRepo.addPausedChat(chatId, username || null);
}

function resumeChat(chatId) {
  waRepo.removePausedChat(chatId);
}

function getPausedChats() {
  return waRepo.getAllPausedChats();
}

// ---------------------------------------------------------------------------
// Global bot toggle (DB-persisted)
// ---------------------------------------------------------------------------

function isBotEnabled() {
  return waRepo.isBotEnabled();
}

function setBotEnabled(enabled) {
  waRepo.setSetting('bot_enabled', enabled ? '1' : '0');
}

// ---------------------------------------------------------------------------
// Link fixer
// ---------------------------------------------------------------------------

/**
 * Post-process an AI reply to replace [LINK:tag] placeholders with real URLs,
 * strip broken/partial domain URLs, and auto-detect topic URLs from keywords.
 *
 * @param {string} reply
 * @returns {string}
 */
function fixReplyLinks(reply) {
  // Step 1: Replace [LINK:tag] with actual URLs
  reply = reply.replace(/\[LINK:([a-z0-9\-]+)\]/gi, (match, tag) => {
    const url = SERVICE_LINKS[tag.toLowerCase()];
    return url ? `\n\n${url}\n` : '';
  });

  // Step 2: Strip all URLs from our domain (broken, truncated, or complete)
  // We'll re-add the correct one in Step 4.
  // NO 'i' flag so it stops at uppercase letters.
  const strippedUrls = [];
  reply = reply.replace(/https?:\/\/drnakhoda\.scalamatic\.com[a-z0-9\-\/.#]*/g, (match) => {
    strippedUrls.push(match);
    return '';
  });

  // Step 3: Determine the correct URL to use
  // First check if any stripped URL was a valid complete one
  let correctUrl = null;
  for (const url of strippedUrls) {
    if (ALL_SERVICE_URLS.includes(url)) {
      correctUrl = url;
      break;
    }
  }

  // If no valid URL was found, detect topic from keywords
  if (!correctUrl) {
    const replyLower = reply.toLowerCase();
    let bestMatch = null;
    let bestLen = 0;
    for (const [keyword, tag] of Object.entries(SERVICE_KEYWORDS)) {
      if (replyLower.includes(keyword) && keyword.length > bestLen) {
        bestMatch = tag;
        bestLen = keyword.length;
      }
    }
    if (bestMatch && SERVICE_LINKS[bestMatch]) {
      correctUrl = SERVICE_LINKS[bestMatch];
    }
  }

  // Step 4: Append the correct URL at the end, properly spaced
  if (correctUrl) {
    reply = reply.trimEnd() + '\n\n' + correctUrl;
  }

  // Step 5: Clean up extra whitespace/newlines
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();

  return reply;
}

// ---------------------------------------------------------------------------
// GPT (Groq) reply generation
// ---------------------------------------------------------------------------

/**
 * Generate an AI reply to a WhatsApp message using the Groq API (OpenAI
 * compatible). Conversation history is pulled from the DB.
 *
 * SECURITY: full message content is NOT logged — only the first 50 characters.
 *
 * @param {string} phone
 * @param {string} incomingText
 * @param {string|null} chatName
 * @returns {Promise<string>}
 */
async function getGPTReply(phone, incomingText, chatName) {
  if (!config.GROQ_API_KEY) {
    return "Thank you for your message. Our team will get back to you shortly. For immediate assistance, call us at +92-300-2105374.";
  }

  // Get conversation history for context
  const history = waRepo.getConversationHistory(phone, 20).reverse();

  // Build OpenAI-compatible messages array
  let systemInstruction = CLINIC_SYSTEM_PROMPT;
  if (chatName) {
    systemInstruction += `\n\nCurrent patient's WhatsApp name: ${chatName}`;
  }

  const messages = [{ role: 'system', content: systemInstruction }];

  for (const msg of history) {
    messages.push({
      role: msg.direction === 'in' ? 'user' : 'assistant',
      content: msg.message,
    });
  }

  messages.push({ role: 'user', content: incomingText });

  try {
    logEvent('info', `Groq request for ${phone}`, `${messages.length} messages, last: "${incomingText.substring(0, 50)}"`);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 350,
        temperature: 0.7,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || JSON.stringify(data).substring(0, 200);
      logEvent('error', 'Groq API error', `${response.status}: ${errMsg}`);
      return 'Sorry, I\'m having trouble responding right now. Please call us directly at +92-300-2105374.';
    }

    let reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      logEvent('error', 'Groq empty response', JSON.stringify(data).substring(0, 200));
      return 'Thank you for reaching out! Please call us at +92-300-2105374 for assistance.';
    }

    reply = fixReplyLinks(reply);

    logEvent('info', `Groq reply for ${phone}`, reply.substring(0, 80));
    return reply;
  } catch (err) {
    logEvent('error', 'Groq API error', err.message);
    return 'Sorry, I\'m having trouble responding right now. Please call us directly at +92-300-2105374.';
  }
}

// ---------------------------------------------------------------------------
// Appointment sync & scheduling
// ---------------------------------------------------------------------------

/**
 * Parse a date string as local time (no timezone shift).
 * Clinicea returns dates already in Pakistan local time (e.g. "2026-03-25T10:30:00").
 * new Date() would treat this as UTC — we need to keep it as-is.
 */
function parseLocalDate(str) {
  if (!str) return new Date();
  // If the string has no timezone indicator, parse components directly
  const m = String(str).match(/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(
      parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
      parseInt(m[4] || 0), parseInt(m[5] || 0), parseInt(m[6] || 0)
    );
  }
  return new Date(str);
}

/** Format date as "Monday, 25 March 2026" */
function formatDatePK(d) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

/** Format time as "10:30 AM" */
function formatTimePK(d) {
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return String(h).padStart(2, '0') + ':' + min + ' ' + ampm;
}

/**
 * Fetch appointments for the next 7 days from Clinicea, upsert tracking
 * records, and queue confirmation + reminder messages for unsent items.
 *
 * This should be called on a 30-minute interval.
 */
async function syncAppointmentsAndScheduleMessages() {
  if (!isClinicaConfigured() || !cliniceaService) return;
  if (!isBotEnabled()) {
    logEvent('info', 'Appointment sync skipped — WA bot globally disabled');
    return;
  }

  try {
    // Fetch appointments for the next 7 days
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
      dates.push(d.toISOString().split('T')[0]);
    }

    for (const date of dates) {
      const data = await cliniceaService.cliniceaFetch(
        `/api/v3/appointments/getAppointmentsByDate?appointmentDate=${date}&pageNo=1&pageSize=100`
      );
      const appointments = Array.isArray(data) ? data : [];

      for (const apt of appointments) {
        const appointmentId = String(apt.AppointmentID || apt.ID || apt.Id || '');
        if (!appointmentId) continue;

        const status = apt.AppointmentStatus || apt.Status || '';
        if (status === 'Cancelled') continue;

        const patientName =
          apt.AppointmentWithName ||
          apt.PatientName ||
          [apt.PatientFirstName || apt.FirstName, apt.PatientLastName || apt.LastName]
            .filter(Boolean)
            .join(' ') ||
          'Patient';
        const patientPhone = apt.AppointmentWithPhone || apt.PatientMobile || apt.Mobile || '';
        const patientId = String(apt.PatientID || apt.patientID || '');
        const doctorName = apt.DoctorName || apt.Doctor || 'Dr. Nakhoda';
        const service = apt.ServiceName || apt.Service || '';
        const aptDate = apt.StartDateTime || apt.AppointmentDateTime || date;

        // Normalize phone
        let phone = patientPhone.replace(/[\s\-()]/g, '');
        if (!phone) continue;
        phone = normalizePKPhone(phone);
        // Ensure a leading + for international format
        if (phone && !phone.startsWith('+')) {
          phone = '+' + phone;
        }

        // Upsert tracking record
        waRepo.upsertAppointmentTracking(appointmentId, patientId, patientName, phone, aptDate, doctorName, service);
      }
    }

    // --- Send Confirmation Messages (grouped by patient phone) ---
    const unsent = waRepo.getUnsentConfirmations();
    const confirmByPhone = {};
    for (const apt of unsent) {
      const phone = apt.patient_phone;
      if (!confirmByPhone[phone]) confirmByPhone[phone] = [];
      confirmByPhone[phone].push(apt);
    }

    for (const [phone, apts] of Object.entries(confirmByPhone)) {
      const name = apts[0].patient_name;
      let msg = `Assalam o Alaikum ${name}! Your appointment${apts.length > 1 ? 's' : ''} at Dr. Nakhoda's Skin Institute ${apts.length > 1 ? 'have' : 'has'} been scheduled.\n`;

      for (const apt of apts) {
        const aptDate = parseLocalDate(apt.appointment_date);
        msg += `\n${formatDatePK(aptDate)} at ${formatTimePK(aptDate)}`;
        if (apt.service) msg += ` — ${apt.service}`;
        if (apt.doctor_name) msg += ` (${apt.doctor_name})`;
      }

      msg += '\n\nLocation: GPC 11, Rojhan Street, Block 5, Clifton, Karachi\nhttps://maps.app.goo.gl/YadKKdh4911HmxKL9';
      msg += '\n\nPlease reply "CONFIRM" to confirm or call +92-300-2105374 to reschedule. We look forward to seeing you!';

      waRepo.insertMessage(phone, null, 'out', msg, 'confirmation', 'pending', null);
      for (const apt of apts) {
        waRepo.markConfirmationSent(apt.id);
      }
      logEvent('info', `WA confirmation queued for ${name} (${phone}) — ${apts.length} appointment(s)`);
    }

    // --- Send Reminder Messages (grouped by patient phone, 0-2 days before) ---
    const reminderCandidates = waRepo.getUnsentReminders();
    const reminderByPhone = {};

    for (const apt of reminderCandidates) {
      const aptParsed = parseLocalDate(apt.appointment_date);
      const aptDateOnly = new Date(aptParsed.getFullYear(), aptParsed.getMonth(), aptParsed.getDate());
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const daysUntil = Math.round((aptDateOnly - todayOnly) / (24 * 60 * 60 * 1000));

      if (daysUntil <= 2 && daysUntil >= 0) {
        const phone = apt.patient_phone;
        if (!reminderByPhone[phone]) reminderByPhone[phone] = { apts: [], daysUntil };
        reminderByPhone[phone].apts.push(apt);
        // Use the closest appointment's daysUntil
        if (daysUntil < reminderByPhone[phone].daysUntil) {
          reminderByPhone[phone].daysUntil = daysUntil;
        }
      }
    }

    for (const [phone, group] of Object.entries(reminderByPhone)) {
      const { apts, daysUntil } = group;
      const name = apts[0].patient_name;

      let dayWord = 'soon';
      if (daysUntil === 0) dayWord = 'today';
      else if (daysUntil === 1) dayWord = 'tomorrow';
      else if (daysUntil === 2) dayWord = 'in 2 days';

      let msg = `Reminder: Assalam o Alaikum ${name}! This is a friendly reminder that your appointment${apts.length > 1 ? 's' : ''} at Dr. Nakhoda's Skin Institute ${apts.length > 1 ? 'are' : 'is'} ${dayWord}.\n`;

      for (const apt of apts) {
        const aptDate = parseLocalDate(apt.appointment_date);
        msg += `\n${formatDatePK(aptDate)} at ${formatTimePK(aptDate)}`;
        if (apt.service) msg += ` — ${apt.service}`;
      }

      msg += '\n\nPlease arrive 10 minutes early. If you need to reschedule, call +92-300-2105374. See you soon!';

      waRepo.insertMessage(phone, null, 'out', msg, 'reminder', 'pending', null);
      for (const apt of apts) {
        waRepo.markReminderSent(apt.id);
      }
      logEvent('info', `WA reminder queued for ${name} (${phone}) — ${apts.length} appointment(s), ${dayWord}`);
    }

    logEvent('info', 'Appointment sync complete');
  } catch (err) {
    logEvent('error', 'Appointment sync failed', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fixReplyLinks,
  getGPTReply,
  syncAppointmentsAndScheduleMessages,
  isPaused,
  pauseChat,
  resumeChat,
  getPausedChats,
  isBotEnabled,
  setBotEnabled,
  setClinicaService,
};
