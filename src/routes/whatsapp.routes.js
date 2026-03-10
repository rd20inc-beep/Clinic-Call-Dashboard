'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');
const { config } = require('../config/env');
const { logEvent } = require('../services/logging.service');
const waRepo = require('../db/whatsapp.repo');

// ---------------------------------------------------------------------------
// GPT / Groq integration
// ---------------------------------------------------------------------------

const WEBSITE_BASE = 'https://drnakhoda.scalamatic.com';

const SERVICE_LINKS = {
  'laser-hair-removal': WEBSITE_BASE + '/services/laser-hair-removal',
  'weightloss': WEBSITE_BASE + '/services/weightloss-and-slimming',
  'coolsculpting': WEBSITE_BASE + '/services/weightloss-and-slimming#coolsculpting',
  'emsculpt': WEBSITE_BASE + '/services/weightloss-and-slimming#emsculpt-neo',
  'fat-dissolving': WEBSITE_BASE + '/services/weightloss-and-slimming#fat-dissolving',
  'skin-rejuvenation': WEBSITE_BASE + '/services/skin-rejuvenation',
  'hydrafacial': WEBSITE_BASE + '/services/skin-rejuvenation#hydrafacial',
  'prx-t33': WEBSITE_BASE + '/services/skin-rejuvenation#prx-t33',
  'rf-microneedling': WEBSITE_BASE + '/services/skin-rejuvenation#rf-microneedling',
  'chemical-peel': WEBSITE_BASE + '/services/skin-rejuvenation#chemical-peel',
  'prp': WEBSITE_BASE + '/services/skin-rejuvenation#prp',
  'anti-aging': WEBSITE_BASE + '/services/anti-aging-rejuvenation',
  'botox': WEBSITE_BASE + '/services/anti-aging-rejuvenation#botox',
  'fillers': WEBSITE_BASE + '/services/anti-aging-rejuvenation#dermal-fillers',
  'thread-lift': WEBSITE_BASE + '/services/anti-aging-rejuvenation#thread-lift',
  'dermatology': WEBSITE_BASE + '/services/dermatology',
  'acne': WEBSITE_BASE + '/services/dermatology#acne-treatment',
  'vitiligo': WEBSITE_BASE + '/services/dermatology#vitiligo-treatment',
  'psoriasis': WEBSITE_BASE + '/services/dermatology#psoriasis-treatment',
  'hair-restoration': WEBSITE_BASE + '/services/hair-restoration',
  'regenera': WEBSITE_BASE + '/services/hair-restoration#regenera-activa',
  'hair-prp': WEBSITE_BASE + '/services/hair-restoration#hair-prp',
  'intimate-health': WEBSITE_BASE + '/services/intimate-health',
  'thermiva': WEBSITE_BASE + '/services/intimate-health#thermiva',
  'emsella': WEBSITE_BASE + '/services/intimate-health#emsella',
  'treatments': WEBSITE_BASE + '/treatments',
};

const ALL_SERVICE_URLS = Object.values(SERVICE_LINKS);

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

function fixReplyLinks(reply) {
  // Step 1: Replace [LINK:tag] with actual URLs
  reply = reply.replace(/\[LINK:([a-z0-9\-]+)\]/gi, (match, tag) => {
    const url = SERVICE_LINKS[tag.toLowerCase()];
    return url ? '\n\n' + url + '\n' : '';
  });

  // Step 2: Strip all URLs from our domain
  const strippedUrls = [];
  reply = reply.replace(
    /https?:\/\/drnakhoda\.scalamatic\.com[a-z0-9\-/.#]*/g,
    (match) => {
      strippedUrls.push(match);
      return '';
    }
  );

  // Step 3: Determine the correct URL to use
  let correctUrl = null;
  for (const url of strippedUrls) {
    if (ALL_SERVICE_URLS.includes(url)) {
      correctUrl = url;
      break;
    }
  }

  // If no valid URL found, detect topic from keywords
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

  // Step 4: Append the correct URL
  if (correctUrl) {
    reply = reply.trimEnd() + '\n\n' + correctUrl;
  }

  // Step 5: Clean up extra whitespace
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();

  return reply;
}

const CLINIC_SYSTEM_PROMPT = `You are the WhatsApp assistant for Dr. Nakhoda's Skin Institute, a premier dermatology and aesthetic clinic in Karachi, Pakistan.

CLINIC INFO:
- Name: Dr. Nakhoda's Skin Institute
- Lead Doctor: Dr. Tasneem Nakhoda - Board Certified Dermatologist, 20+ years experience, trained in Pakistan & USA
- Location: GPC 11, Rojhan Street, Block 5, Clifton, Karachi
- Phone: +92-300-2105374, +92-321-3822113
- Hours: 9 AM to 11 PM (call to book)
- Onsite pharmacy with skincare products

SERVICES (use the tag in square brackets when mentioning a service):
1. Laser Hair Removal [LINK:laser-hair-removal] - Permanent hair reduction using light energy for all skin types. 3-7 sessions, 80-90% reduction.
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

- ALWAYS put [LINK:tag] on its own separate line with a blank line before and after it. Never write a URL yourself - only use [LINK:tag] tags.
- If a patient asks generally about services, use [LINK:treatments]
- If asked about pricing, say "Prices vary by treatment. Would you like me to schedule a consultation so the doctor can assess and give you exact pricing?"
- Always try to guide toward booking an appointment
- Be warm, professional, and helpful
- If you don't know something specific, say you'll check with the doctor and get back
- For emergencies, tell them to call the clinic directly
- Never make up medical advice or diagnoses
- If someone confirms an appointment reminder, say "Great! We look forward to seeing you. If you need to reschedule, just let us know."
- Sign off messages naturally, no need for formal signatures`;

async function getGPTReply(phone, incomingText, chatName) {
  if (!config.GROQ_API_KEY) {
    return 'Thank you for your message. Our team will get back to you shortly. For immediate assistance, call us at +92-300-2105374.';
  }

  // Get conversation history for context
  const history = waRepo.getConversationHistory(phone, 20).reverse();

  let systemInstruction = CLINIC_SYSTEM_PROMPT;
  if (chatName) {
    systemInstruction += '\n\nCurrent patient\'s WhatsApp name: ' + chatName;
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
    logEvent(
      'info',
      'Groq request for ' + phone,
      messages.length + ' messages, last: "' + incomingText.substring(0, 50) + '"'
    );

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messages,
        max_tokens: 350,
        temperature: 0.7,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg =
        (data.error && data.error.message) ||
        JSON.stringify(data).substring(0, 200);
      logEvent('error', 'Groq API error', response.status + ': ' + errMsg);
      return 'Sorry, I\'m having trouble responding right now. Please call us directly at +92-300-2105374.';
    }

    let reply =
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;
    reply = reply ? reply.trim() : null;

    if (!reply) {
      logEvent(
        'error',
        'Groq empty response',
        JSON.stringify(data).substring(0, 200)
      );
      return 'Thank you for reaching out! Please call us at +92-300-2105374 for assistance.';
    }

    reply = fixReplyLinks(reply);

    logEvent('info', 'Groq reply for ' + phone, reply.substring(0, 80));
    return reply;
  } catch (err) {
    logEvent('error', 'Groq API error', err.message);
    return 'Sorry, I\'m having trouble responding right now. Please call us directly at +92-300-2105374.';
  }
}

// ---------------------------------------------------------------------------
// Paused chats (in memory)
// ---------------------------------------------------------------------------
const pausedChats = new Set();

// ---------------------------------------------------------------------------
// Extension auth middleware (inline)
// ---------------------------------------------------------------------------
function requireExtensionAuth(req, res, next) {
  if (!config.EXTENSION_SECRET) return next();
  const provided = req.headers['x-extension-key'];
  if (provided !== config.EXTENSION_SECRET) {
    logEvent('warn', 'Extension auth failed', 'IP: ' + req.ip);
    return res.status(401).json({ error: 'Invalid extension key', reply: null });
  }
  next();
}

// ---------------------------------------------------------------------------
// Setup function — returns router, accepts io for socket emissions
// ---------------------------------------------------------------------------

/**
 * @param {import('socket.io').Server} io
 * @returns {import('express').Router}
 */
module.exports = function setupWhatsAppRoutes(io) {
  const router = express.Router();

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/incoming - incoming WA message (extension-auth)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/incoming', requireExtensionAuth, async (req, res) => {
    const { messageId, text, phone, chatName, timestamp } = req.body;

    if (!text || (!phone && !chatName)) {
      return res.json({ reply: null });
    }

    const contactId = phone || chatName || 'unknown';
    logEvent(
      'info',
      'WA message from ' + (chatName || phone) + ': ' + text.substring(0, 50)
    );

    // Store incoming message
    waRepo.insertMessage(contactId, chatName || null, 'in', text, 'chat', 'sent', null);

    // Check if bot is paused for this chat
    if (pausedChats.has(contactId) || pausedChats.has(chatName)) {
      logEvent('info', 'WA bot paused for ' + (chatName || phone) + ', skipping reply');
      // IMPORTANT: emit to admin only, not io.emit to all
      io.to('role:admin').emit('wa_message', {
        phone: contactId,
        chatName,
        direction: 'in',
        text,
        reply: null,
        timestamp: new Date().toISOString(),
      });
      return res.json({ reply: null });
    }

    // Get GPT reply
    const reply = await getGPTReply(contactId, text, chatName);

    // Store outgoing reply
    waRepo.insertMessage(contactId, chatName || null, 'out', reply, 'chat', 'sent', null);

    logEvent(
      'info',
      'WA reply to ' + (chatName || phone) + ': ' + reply.substring(0, 50)
    );

    // IMPORTANT: emit to admin only, not io.emit to all
    io.to('role:admin').emit('wa_message', {
      phone: contactId,
      chatName,
      direction: 'in',
      text,
      reply,
      timestamp: new Date().toISOString(),
    });

    return res.json({ reply });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/outgoing - poll for pending outgoing messages
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/outgoing', requireExtensionAuth, (req, res) => {
    const pending = waRepo.getPendingOutgoing();
    const messages = pending.map((m) => ({
      id: m.id,
      phone: m.phone,
      text: m.message,
      type: m.message_type,
    }));
    return res.json({ messages });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/sent - confirm message was sent by extension
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/sent', requireExtensionAuth, (req, res) => {
    const { id, phone, success } = req.body;
    if (id) {
      if (success) {
        waRepo.markMessageSent(id);
        logEvent('info', 'WA scheduled message delivered to ' + phone);
      } else {
        waRepo.markMessageFailed(id);
        logEvent('warn', 'WA scheduled message failed for ' + phone);
      }
    }
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/send - manual message from dashboard (auth-protected)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/send', requireAuth, (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.json({ error: 'phone and message required' });
    }

    waRepo.insertMessage(
      phone,
      null,
      'out',
      message,
      'chat',
      'pending',
      req.session.username || null
    );
    logEvent(
      'info',
      'WA manual message queued for ' + phone + ' by ' + req.session.username
    );
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/pause - pause bot for a specific chat
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/pause', requireAuth, (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.json({ error: 'chatId required' });
    pausedChats.add(chatId);
    logEvent(
      'info',
      'WA bot paused for "' + chatId + '" by ' + req.session.username
    );
    return res.json({ ok: true, paused: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/resume - resume bot for a specific chat
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/resume', requireAuth, (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.json({ error: 'chatId required' });
    pausedChats.delete(chatId);
    logEvent(
      'info',
      'WA bot resumed for "' + chatId + '" by ' + req.session.username
    );
    return res.json({ ok: true, paused: false });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/paused - list paused chats
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/paused', requireAuth, (req, res) => {
    return res.json({ pausedChats: Array.from(pausedChats) });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/history/:phone - conversation history (agent-filtered)
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/history/:phone', requireAuth, (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    const isAdmin = req.session.role === 'admin';
    const agent = req.session.username;

    let messages;
    if (isAdmin) {
      messages = waRepo.getAllConversationHistory(phone, 50);
    } else {
      messages = waRepo.getConversationHistoryByAgent(phone, agent, 50);
    }

    return res.json({ messages: messages.reverse() });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/conversations - grouped conversation list (agent-filtered)
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/conversations', requireAuth, (req, res) => {
    const isAdmin = req.session.role === 'admin';
    const agent = req.session.username;
    const conversations = waRepo.getConversations(isAdmin, agent);
    return res.json({ conversations });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/stats - aggregate WA stats
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/stats', requireAuth, (req, res) => {
    const isAdmin = req.session.role === 'admin';
    const agent = req.session.username;
    const stats = waRepo.getStats(isAdmin, agent);
    return res.json(stats);
  });

  return router;
};
