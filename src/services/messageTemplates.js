'use strict';

const waRepo = require('../db/whatsapp.repo');

// Default templates with variable placeholders
const DEFAULT_TEMPLATES = {
  confirmation: `Assalam o Alaikum {name}! Your appointment at Dr. Nakhoda's Skin Institute has been confirmed.

{appointments}

If you need to reschedule, call +92-300-2105374. We look forward to seeing you!`,

  reminder: `Assalam o Alaikum {name}! This is a friendly reminder that your appointment at Dr. Nakhoda's Skin Institute is {day_word}.

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
 * Get all templates (saved + defaults merged).
 */
function getAllTemplates() {
  const result = {};
  for (const key of Object.keys(DEFAULT_TEMPLATES)) {
    const saved = waRepo.getSetting('template_' + key);
    result[key] = {
      key,
      text: saved || DEFAULT_TEMPLATES[key],
      isCustom: !!saved,
      default: DEFAULT_TEMPLATES[key],
    };
  }
  return result;
}

/**
 * Reset a template to default.
 */
function resetTemplate(key) {
  waRepo.setSetting('template_' + key, DEFAULT_TEMPLATES[key] || '');
}

/**
 * Apply variables to a template string.
 * Variables: {name}, {date}, {time}, {service}, {doctor}, {location}, {phone},
 *            {day_word}, {appointments}, {service_text}, {doctor_text}
 */
function applyTemplate(templateKey, vars) {
  let text = getTemplate(templateKey);
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
  DEFAULT_TEMPLATES,
};
