'use strict';

const waRepo = require('../db/whatsapp.repo');

// Default templates with variable placeholders
const DEFAULT_TEMPLATES = {
  confirmation: `Assalam o Alaikum {name}! Your appointment at Dr. Nakhoda's Skin Institute has been confirmed.

{appointments}

If you need to reschedule, call +92-300-2105374. We look forward to seeing you!`,

  reminder: `Assalam o Alaikum! This is a friendly reminder about your appointment at Dr. Nakhoda's Skin Institute on {date}.

{appointments}

Location: GPC 11, Rojhan Street, Block 5, Clifton, Karachi
https://maps.app.goo.gl/YadKKdh4911HmxKL9

Please arrive 10 minutes early. See you soon!`,

  review: `Assalam o Alaikum {name}! Thank you for visiting Dr. Nakhoda's Skin Institute today.

We hope you had a great experience{service_text}{doctor_text}.

We would really appreciate if you could leave us a quick review:
https://g.page/r/drnakhoda/review

Your feedback helps us serve you better. Thank you!`,

  aftercare_general: `Assalam o Alaikum {name}! Here are your aftercare instructions following your visit at Dr. Nakhoda's Skin Institute.

General Aftercare:
- Follow the instructions given by your doctor
- Apply prescribed medications as directed
- Avoid direct sun exposure and use sunscreen
- Stay hydrated and rest well

If you have any questions or concerns, please call us at +92-300-2105374.`,

  aftercare_laser: `Assalam o Alaikum {name}! Here are your aftercare instructions for Laser Treatment.

- Avoid sun exposure for 48 hours
- Apply SPF 50+ sunscreen daily
- Avoid hot showers/saunas for 24 hours
- Do not scratch or pick the treated area
- Apply aloe vera gel if you feel any irritation

If you have any questions, call us at +92-300-2105374.`,

  aftercare_facial: `Assalam o Alaikum {name}! Here are your aftercare instructions for HydraFacial.

- Avoid makeup for 6-12 hours
- Use gentle cleanser and moisturizer
- Apply SPF 30+ sunscreen daily
- Avoid exfoliating for 48 hours
- Stay hydrated and avoid alcohol for 24 hours

If you have any questions, call us at +92-300-2105374.`,

  aftercare_botox: `Assalam o Alaikum {name}! Here are your aftercare instructions for Injectable Treatment.

- Do not touch or massage the treated area for 4 hours
- Avoid lying down for 4 hours after treatment
- Avoid strenuous exercise for 24 hours
- Avoid alcohol and blood thinners for 24 hours
- Mild swelling/bruising is normal and will resolve in a few days

If you have any questions, call us at +92-300-2105374.`,

  aftercare_peel: `Assalam o Alaikum {name}! Here are your aftercare instructions for Chemical Peel.

- Do not pick or peel flaking skin
- Apply prescribed moisturizer frequently
- Avoid sun exposure — use SPF 50+ daily
- Avoid retinol/AHA products for 1 week
- Keep the area clean and hydrated

If you have any questions, call us at +92-300-2105374.`,

  aftercare_microneedling: `Assalam o Alaikum {name}! Here are your aftercare instructions for Microneedling/PRP.

- Avoid touching the face for 6 hours
- No makeup for 24 hours
- Use gentle cleanser and prescribed serum only
- Avoid sun and apply SPF 50+ daily
- Redness is normal and will subside in 24-48 hours

If you have any questions, call us at +92-300-2105374.`,
};

/**
 * Get a template by key. Returns saved version from DB, or default.
 */
function getTemplate(key) {
  const saved = waRepo.getSetting('template_' + key);
  return saved || DEFAULT_TEMPLATES[key] || '';
}

/**
 * Save a template to DB.
 */
function setTemplate(key, text) {
  waRepo.setSetting('template_' + key, text);
}

/**
 * Get all templates (defaults + custom-added from DB).
 */
function getAllTemplates() {
  const result = {};
  // 1. Load defaults
  for (const key of Object.keys(DEFAULT_TEMPLATES)) {
    const saved = waRepo.getSetting('template_' + key);
    result[key] = {
      key,
      text: saved || DEFAULT_TEMPLATES[key],
      isCustom: !!saved,
      isUserCreated: false,
      default: DEFAULT_TEMPLATES[key],
    };
  }
  // 2. Load user-created templates from DB (template_custom_*)
  try {
    const { db } = require('../db/index');
    const rows = db.prepare("SELECT key, value FROM wa_settings WHERE key LIKE 'template_custom_%'").all();
    for (const row of rows) {
      const key = row.key.replace('template_', '');
      if (!result[key]) {
        const displayName = waRepo.getSetting('template_name_' + key);
        result[key] = {
          key,
          text: row.value,
          isCustom: true,
          isUserCreated: true,
          displayName: displayName || key.replace(/^custom_/, '').replace(/_/g, ' '),
          default: '',
        };
      }
    }
  } catch (e) { console.error('[templates] Failed to load custom templates:', e.message); }
  return result;
}

/**
 * Create a new custom template.
 */
function createTemplate(name, text) {
  const key = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  waRepo.setSetting('template_' + key, text);
  // Also save the display name
  waRepo.setSetting('template_name_' + key, name);
  return key;
}

/**
 * Delete a user-created template.
 */
function deleteTemplate(key) {
  if (DEFAULT_TEMPLATES[key]) return false; // Can't delete defaults
  try {
    const { db } = require('../db/index');
    db.prepare("DELETE FROM wa_settings WHERE key = ?").run('template_' + key);
    db.prepare("DELETE FROM wa_settings WHERE key = ?").run('template_name_' + key);
    return true;
  } catch (e) { return false; }
}

/**
 * Get the display name for a template key.
 */
function getTemplateName(key) {
  if (key.startsWith('custom_')) {
    const saved = waRepo.getSetting('template_name_' + key);
    if (saved) return saved;
  }
  return null;
}

/**
 * Reset a template to default.
 */
function resetTemplate(key) {
  waRepo.setSetting('template_' + key, DEFAULT_TEMPLATES[key] || '');
}

/**
 * Convert a service name to a template key suffix.
 * e.g. "Laser Hair Removal" → "laser_hair_removal"
 */
function serviceToKey(service) {
  return (service || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Get a service-specific template if it exists, otherwise fall back to default.
 * e.g. getServiceTemplate('confirmation', 'Laser Hair Removal')
 *   → checks 'confirmation_laser_hair_removal' first, then 'confirmation'
 */
function getServiceTemplate(templateKey, service) {
  if (service) {
    const serviceKey = templateKey + '_' + serviceToKey(service);
    const specific = waRepo.getSetting('template_' + serviceKey);
    if (specific) return specific;
  }
  return getTemplate(templateKey);
}

/**
 * Save a service-specific template.
 */
function setServiceTemplate(templateKey, service, text) {
  const serviceKey = templateKey + '_' + serviceToKey(service);
  waRepo.setSetting('template_' + serviceKey, text);
}

/**
 * Delete a service-specific template (reverts to default).
 */
function deleteServiceTemplate(templateKey, service) {
  const serviceKey = templateKey + '_' + serviceToKey(service);
  try {
    const { db } = require('../db/index');
    db.prepare("DELETE FROM wa_settings WHERE key = ?").run('template_' + serviceKey);
    return true;
  } catch (e) { return false; }
}

/**
 * Get all service-specific templates for a given type (confirmation/reminder/aftercare).
 * Returns { serviceName: templateText, ... }
 */
function getServiceTemplates(templateKey) {
  const prefix = 'template_' + templateKey + '_';
  try {
    const { db } = require('../db/index');
    const rows = db.prepare("SELECT key, value FROM wa_settings WHERE key LIKE ?").all(prefix + '%');
    const result = {};
    for (const row of rows) {
      const serviceKey = row.key.replace('template_' + templateKey + '_', '');
      result[serviceKey] = row.value;
    }
    return result;
  } catch (e) { return {}; }
}

/**
 * Get all known services from appointment tracking.
 */
function getAllServices() {
  try {
    const { db } = require('../db/index');
    return db.prepare("SELECT DISTINCT service FROM wa_appointment_tracking WHERE service IS NOT NULL AND service != '' ORDER BY service").all().map(r => r.service);
  } catch (e) { return []; }
}

/**
 * Apply variables to a template string, with service-specific override.
 * If vars.service is set, checks for a service-specific template first.
 */
function applyTemplate(templateKey, vars) {
  let text = vars && vars.service
    ? getServiceTemplate(templateKey, vars.service)
    : getTemplate(templateKey);
  if (!text) return '';
  for (const [k, v] of Object.entries(vars || {})) {
    text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v || '');
  }
  // Clean up any remaining placeholders
  text = text.replace(/\{[a-z_]+\}/g, '');
  return text.trim();
}

module.exports = {
  getTemplate,
  setTemplate,
  getAllTemplates,
  resetTemplate,
  applyTemplate,
  createTemplate,
  deleteTemplate,
  getTemplateName,
  getServiceTemplate,
  setServiceTemplate,
  deleteServiceTemplate,
  getServiceTemplates,
  getAllServices,
  serviceToKey,
  DEFAULT_TEMPLATES,
};
