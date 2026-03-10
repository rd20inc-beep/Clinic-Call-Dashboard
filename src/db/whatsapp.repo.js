'use strict';

const { db } = require('./index');

// --- Prepared statements ---

const stmtInsertMessage = db.prepare(`
  INSERT INTO wa_messages (phone, chat_name, direction, message, message_type, status, agent)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetPendingOutgoing = db.prepare(
  "SELECT * FROM wa_messages WHERE direction = 'out' AND status = 'pending' ORDER BY created_at ASC LIMIT 5"
);

const stmtMarkMessageSent = db.prepare(
  "UPDATE wa_messages SET status = 'sent' WHERE id = ?"
);

const stmtMarkMessageFailed = db.prepare(
  "UPDATE wa_messages SET status = 'failed' WHERE id = ?"
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

const stmtGetUnsentConfirmations = db.prepare(
  "SELECT * FROM wa_appointment_tracking WHERE confirmation_sent = 0 AND patient_phone IS NOT NULL AND patient_phone != ''"
);

const stmtGetUnsentReminders = db.prepare(
  "SELECT * FROM wa_appointment_tracking WHERE reminder_sent = 0 AND confirmation_sent = 1 AND patient_phone IS NOT NULL AND patient_phone != ''"
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
  insertMessage(phone, chatName, direction, message, messageType, status, agent) {
    const result = stmtInsertMessage.run(
      phone,
      chatName || null,
      direction,
      message,
      messageType || 'chat',
      status || 'sent',
      agent || null
    );
    return result.lastInsertRowid;
  },

  /**
   * Get up to 5 pending outgoing messages.
   * @returns {object[]}
   */
  getPendingOutgoing() {
    return stmtGetPendingOutgoing.all();
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
   * @returns {{ totalMessages: number, todayMessages: number, pendingMessages: number, totalConfirmations: number, totalReminders: number, pendingConfirmations: number }}
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

    return {
      totalMessages,
      todayMessages,
      pendingMessages,
      totalConfirmations,
      totalReminders,
      pendingConfirmations,
    };
  },
};
