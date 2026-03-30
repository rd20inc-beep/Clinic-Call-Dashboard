'use strict';

const { db } = require('./index');

// --- Prepared statements ---

const stmtInsertMessage = db.prepare(`
  INSERT INTO wa_messages (phone, chat_name, direction, message, message_type, status, agent, wa_message_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Extension only picks up 'approved' messages (admin must approve first)
const stmtGetApprovedOutgoing = db.prepare(
  "SELECT * FROM wa_messages WHERE direction = 'out' AND status = 'approved' ORDER BY created_at ASC LIMIT 5"
);

// Pending = awaiting admin approval
const stmtGetPendingApproval = db.prepare(
  "SELECT * FROM wa_messages WHERE direction = 'out' AND status = 'pending' ORDER BY created_at DESC LIMIT 50"
);

const stmtApproveMessage = db.prepare(
  "UPDATE wa_messages SET status = 'approved' WHERE id = ? AND status = 'pending'"
);

const stmtApproveAll = db.prepare(
  "UPDATE wa_messages SET status = 'approved' WHERE direction = 'out' AND status = 'pending'"
);

const stmtRejectMessage = db.prepare(
  "UPDATE wa_messages SET status = 'rejected' WHERE id = ? AND status = 'pending'"
);

const stmtMarkSending = db.prepare(
  "UPDATE wa_messages SET status = 'sending' WHERE id = ?"
);

const stmtExpireStaleApproved = db.prepare(
  "UPDATE wa_messages SET status = 'expired' WHERE direction = 'out' AND status = 'approved' AND created_at < datetime('now', '-10 minutes')"
);

// Expire 'sending' messages stuck for over 5 minutes (extension crashed mid-send)
const stmtExpireStaleSending = db.prepare(
  "UPDATE wa_messages SET status = 'failed' WHERE direction = 'out' AND status = 'sending' AND created_at < datetime('now', '-5 minutes')"
);

const stmtMarkMessageSent = db.prepare(
  "UPDATE wa_messages SET status = 'sent', sent_at = datetime('now') WHERE id = ?"
);

const stmtMarkMessageFailed = db.prepare(
  "UPDATE wa_messages SET status = 'failed' WHERE id = ?"
);

// --- Incoming message dedup ---
const stmtCheckMessageId = db.prepare(
  "SELECT id FROM wa_messages WHERE wa_message_id = ? LIMIT 1"
);

// --- Global bot toggle ---
const stmtGetSetting = db.prepare(
  "SELECT value FROM wa_settings WHERE key = ?"
);
const stmtSetSetting = db.prepare(
  "INSERT INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

// --- Persisted paused chats ---
const stmtAddPausedChat = db.prepare(
  "INSERT OR REPLACE INTO wa_paused_chats (chat_id, paused_by, paused_at) VALUES (?, ?, datetime('now'))"
);
const stmtRemovePausedChat = db.prepare(
  "DELETE FROM wa_paused_chats WHERE chat_id = ?"
);
const stmtGetPausedChats = db.prepare(
  "SELECT chat_id FROM wa_paused_chats"
);
const stmtIsChatPaused = db.prepare(
  "SELECT chat_id FROM wa_paused_chats WHERE chat_id = ? LIMIT 1"
);

// --- Appointment tracking lookup ---
const stmtGetTrackingByPhone = db.prepare(
  "SELECT patient_phone, MIN(confirmation_sent) AS confirmation_sent, MIN(reminder_sent) AS reminder_sent FROM wa_appointment_tracking WHERE patient_phone IS NOT NULL AND patient_phone != '' GROUP BY patient_phone"
);

// --- Failed / expired messages ---
const stmtFailedMessagesCount = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE status = 'failed'"
);
const stmtExpiredMessagesCount = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE status = 'expired'"
);
const stmtGetFailedMessages = db.prepare(
  "SELECT * FROM wa_messages WHERE status IN ('failed', 'expired') ORDER BY created_at DESC LIMIT 50"
);
const stmtRetryMessage = db.prepare(
  "UPDATE wa_messages SET status = 'pending', created_at = datetime('now') WHERE id = ? AND status IN ('failed', 'expired')"
);

const stmtGetConversationHistory = db.prepare(
  'SELECT direction, message, created_at FROM wa_messages WHERE phone = ? ORDER BY created_at DESC LIMIT ?'
);

const stmtGetConversationHistoryByAgent = db.prepare(
  'SELECT * FROM wa_messages WHERE phone = ? AND agent = ? ORDER BY created_at DESC LIMIT ?'
);

const stmtGetAllConversationHistory = db.prepare(
  'SELECT * FROM wa_messages WHERE phone = ? ORDER BY created_at DESC LIMIT ?'
);

const stmtUpsertAppointment = db.prepare(`
  INSERT INTO wa_appointment_tracking (appointment_id, patient_id, patient_name, patient_phone, appointment_date, doctor_name, service)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(appointment_id) DO UPDATE SET
    patient_name = excluded.patient_name,
    patient_phone = excluded.patient_phone,
    appointment_date = excluded.appointment_date,
    doctor_name = excluded.doctor_name,
    service = excluded.service
`);

// Skip walk-in/same-day bookings: if appointment is less than 1 hour after
// the tracking record was created, it's a walk-in — no confirmation or reminder needed.
const WALKIN_CLAUSE = "AND (strftime('%s', appointment_date) - strftime('%s', created_at)) > 3600";

const stmtGetUnsentConfirmations = db.prepare(
  "SELECT * FROM wa_appointment_tracking WHERE confirmation_sent = 0 AND patient_phone IS NOT NULL AND patient_phone != '' " + WALKIN_CLAUSE
);

const stmtGetUnsentReminders = db.prepare(
  "SELECT * FROM wa_appointment_tracking WHERE reminder_sent = 0 AND confirmation_sent = 1 AND patient_phone IS NOT NULL AND patient_phone != '' " + WALKIN_CLAUSE
);

const stmtMarkConfirmationSent = db.prepare(
  "UPDATE wa_appointment_tracking SET confirmation_sent = 1, confirmation_sent_at = datetime('now') WHERE id = ?"
);

const stmtMarkReminderSent = db.prepare(
  "UPDATE wa_appointment_tracking SET reminder_sent = 1, reminder_sent_at = datetime('now') WHERE id = ?"
);

// Conversation list queries
const stmtConversationsAdmin = db.prepare(`
  SELECT phone, chat_name,
         MAX(created_at) AS last_message_at,
         COUNT(*) AS message_count,
         (SELECT message FROM wa_messages w2 WHERE w2.phone = w1.phone ORDER BY created_at DESC LIMIT 1) AS last_message
  FROM wa_messages w1
  GROUP BY phone
  ORDER BY last_message_at DESC
  LIMIT 50
`);

const stmtConversationsAgent = db.prepare(`
  SELECT phone, chat_name,
         MAX(created_at) AS last_message_at,
         COUNT(*) AS message_count,
         (SELECT message FROM wa_messages w2 WHERE w2.phone = w1.phone AND w2.agent = ? ORDER BY created_at DESC LIMIT 1) AS last_message
  FROM wa_messages w1
  WHERE agent = ?
  GROUP BY phone
  ORDER BY last_message_at DESC
  LIMIT 50
`);

// Stats queries — admin
const stmtTotalMessagesAll = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages"
);
const stmtTodayMessagesAll = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE date(created_at) = date('now')"
);
const stmtPendingMessagesAll = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE status = 'pending'"
);

// Stats queries — agent-scoped
const stmtTotalMessagesByAgent = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE agent = ?"
);
const stmtTodayMessagesByAgent = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE date(created_at) = date('now') AND agent = ?"
);
const stmtPendingMessagesByAgent = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_messages WHERE status = 'pending' AND agent = ?"
);

// Stats queries — appointment tracking (global)
const stmtTotalConfirmations = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_appointment_tracking WHERE confirmation_sent = 1"
);
const stmtTotalReminders = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_appointment_tracking WHERE reminder_sent = 1"
);
const stmtPendingConfirmations = db.prepare(
  "SELECT COUNT(*) AS count FROM wa_appointment_tracking WHERE confirmation_sent = 0 AND patient_phone IS NOT NULL AND patient_phone != ''"
);

module.exports = {
  /**
   * Insert a WhatsApp message record.
   */
  insertMessage(phone, chatName, direction, message, messageType, status, agent, waMessageId) {
    const result = stmtInsertMessage.run(
      phone,
      chatName || null,
      direction,
      message,
      messageType || 'chat',
      status || 'sent',
      agent || null,
      waMessageId || null
    );
    return result.lastInsertRowid;
  },

  /**
   * Check if an incoming message with this WA message ID already exists.
   */
  isMessageDuplicate(waMessageId) {
    if (!waMessageId) return false;
    return !!stmtCheckMessageId.get(waMessageId);
  },

  /**
   * Get up to 5 approved outgoing messages and lock them as 'sending'
   * so they won't be returned again on the next poll (prevents double-send).
   * Only approved messages are picked up — pending ones need admin approval first.
   * @returns {object[]}
   */
  getPendingOutgoing() {
    const rows = stmtGetApprovedOutgoing.all();
    for (const row of rows) {
      stmtMarkSending.run(row.id);
    }
    return rows;
  },

  /** Get messages awaiting admin approval. */
  getPendingApproval() {
    return stmtGetPendingApproval.all();
  },

  /** Approve a single message for sending. */
  approveMessage(id) {
    return stmtApproveMessage.run(id);
  },

  /** Approve all pending messages for sending. */
  approveAll() {
    return stmtApproveAll.run();
  },

  /** Reject a pending message (won't be sent). */
  rejectMessage(id) {
    return stmtRejectMessage.run(id);
  },

  /**
   * Mark a message as sent.
   */
  markMessageSent(id) {
    stmtMarkMessageSent.run(id);
  },

  /**
   * Mark a message as failed.
   */
  markMessageFailed(id) {
    stmtMarkMessageFailed.run(id);
  },

  /**
   * Get recent conversation history for a phone number (direction + message + timestamp).
   * @returns {object[]}
   */
  getConversationHistory(phone, limit = 20) {
    return stmtGetConversationHistory.all(phone, limit);
  },

  /**
   * Get conversation history for a phone number filtered by agent.
   * @returns {object[]}
   */
  getConversationHistoryByAgent(phone, agent, limit = 50) {
    return stmtGetConversationHistoryByAgent.all(phone, agent, limit);
  },

  /**
   * Get full conversation history for a phone number (all agents).
   * @returns {object[]}
   */
  getAllConversationHistory(phone, limit = 50) {
    return stmtGetAllConversationHistory.all(phone, limit);
  },

  /**
   * Upsert an appointment tracking record.
   */
  upsertAppointmentTracking(appointmentId, patientId, patientName, patientPhone, appointmentDate, doctorName, service) {
    stmtUpsertAppointment.run(
      appointmentId,
      patientId || null,
      patientName || null,
      patientPhone || null,
      appointmentDate || null,
      doctorName || null,
      service || null
    );
  },

  /**
   * Get appointment records where confirmation has not been sent.
   * @returns {object[]}
   */
  getUnsentConfirmations() {
    return stmtGetUnsentConfirmations.all();
  },

  /**
   * Get appointment records where reminder has not been sent (but confirmation has).
   * @returns {object[]}
   */
  getUnsentReminders() {
    return stmtGetUnsentReminders.all();
  },

  /**
   * Mark an appointment confirmation as sent.
   */
  markConfirmationSent(id) {
    stmtMarkConfirmationSent.run(id);
  },

  /**
   * Mark an appointment reminder as sent.
   */
  markReminderSent(id) {
    stmtMarkReminderSent.run(id);
  },

  /**
   * Get grouped conversations list.
   * @param {boolean} isAdmin
   * @param {string} agent
   * @returns {object[]}
   */
  getConversations(isAdmin, agent) {
    if (isAdmin) {
      return stmtConversationsAdmin.all();
    }
    return stmtConversationsAgent.all(agent, agent);
  },

  /**
   * Get aggregate stats for the WhatsApp dashboard.
   * @param {boolean} isAdmin
   * @param {string} agent
   */
  getStats(isAdmin, agent) {
    let totalMessages, todayMessages, pendingMessages;

    if (isAdmin) {
      totalMessages = stmtTotalMessagesAll.get().count;
      todayMessages = stmtTodayMessagesAll.get().count;
      pendingMessages = stmtPendingMessagesAll.get().count;
    } else {
      totalMessages = stmtTotalMessagesByAgent.get(agent).count;
      todayMessages = stmtTodayMessagesByAgent.get(agent).count;
      pendingMessages = stmtPendingMessagesByAgent.get(agent).count;
    }

    const totalConfirmations = stmtTotalConfirmations.get().count;
    const totalReminders = stmtTotalReminders.get().count;
    const pendingConfirmations = stmtPendingConfirmations.get().count;
    const failedMessages = stmtFailedMessagesCount.get().count;
    const expiredMessages = stmtExpiredMessagesCount.get().count;

    return {
      totalMessages,
      todayMessages,
      pendingMessages,
      totalConfirmations,
      totalReminders,
      pendingConfirmations,
      failedMessages,
      expiredMessages,
    };
  },

  // --- Global bot toggle ---

  /** Get a setting value by key. */
  getSetting(key) {
    const row = stmtGetSetting.get(key);
    return row ? row.value : null;
  },

  /** Set a setting value by key. */
  setSetting(key, value) {
    stmtSetSetting.run(key, String(value));
  },

  /** Check if bot is globally enabled. */
  isBotEnabled() {
    const val = this.getSetting('bot_enabled');
    return val !== '0';
  },

  // --- Persisted paused chats ---

  /** Add a chat to the paused list (persisted in DB). */
  addPausedChat(chatId, pausedBy) {
    stmtAddPausedChat.run(chatId, pausedBy || null);
  },

  /** Remove a chat from the paused list. */
  removePausedChat(chatId) {
    stmtRemovePausedChat.run(chatId);
  },

  /** Get all paused chat IDs. */
  getAllPausedChats() {
    return stmtGetPausedChats.all().map(r => r.chat_id);
  },

  /** Check if a specific chat is paused. */
  isChatPaused(chatId) {
    return !!stmtIsChatPaused.get(chatId);
  },

  // --- Failed messages ---

  /** Get message tracking status grouped by phone. Returns map { phone: { confirmation_sent, reminder_sent } } */
  getTrackingByPhone() {
    const rows = stmtGetTrackingByPhone.all();
    const map = {};
    for (const r of rows) {
      map[r.patient_phone] = { confirmationSent: !!r.confirmation_sent, reminderSent: !!r.reminder_sent };
    }
    return map;
  },

  /** Get all failed messages. */
  getFailedMessages() {
    return stmtGetFailedMessages.all();
  },

  /** Retry a failed message by resetting its status to pending. */
  retryFailedMessage(id) {
    return stmtRetryMessage.run(id);
  },

  /** Expire stale approved messages (>10 min) and stuck sending messages (>5 min). Returns total expired. */
  expireStaleMessages() {
    const expiredApproved = stmtExpireStaleApproved.run().changes;
    const stuckSending = stmtExpireStaleSending.run().changes;
    return expiredApproved + stuckSending;
  },
};
