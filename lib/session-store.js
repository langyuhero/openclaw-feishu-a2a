'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_PATH = path.join(os.homedir(), '.openclaw', 'fbc-registry', 'sessions.json');
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function readSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function writeSessions(sessions) {
  const dir = path.dirname(SESSIONS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

function cleanup(sessions) {
  const now = Date.now();
  let changed = false;
  for (const chatId of Object.keys(sessions)) {
    const s = sessions[chatId];
    if (s.expiresAt && new Date(s.expiresAt).getTime() < now) {
      delete sessions[chatId];
      changed = true;
    }
  }
  return changed;
}

function touchExpiry(session) {
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

function getSession(chatId) {
  const sessions = readSessions();
  cleanup(sessions);
  const session = sessions[chatId];
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    delete sessions[chatId];
    writeSessions(sessions);
    return null;
  }
  return session;
}

function getAllSessions() {
  const sessions = readSessions();
  if (cleanup(sessions)) writeSessions(sessions);
  return sessions;
}

function createSession(chatId, host, hostOpenId, hostName, userRequest) {
  const sessions = readSessions();
  cleanup(sessions);
  const now = new Date().toISOString();
  sessions[chatId] = {
    host,
    hostOpenId,
    hostName,
    userRequest: userRequest || '',
    tasks: [],
    startedAt: now,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  writeSessions(sessions);
  return sessions[chatId];
}

function addTask(chatId, worker, workerOpenId, workerName, brief) {
  const sessions = readSessions();
  const session = sessions[chatId];
  if (!session) return null;

  const existing = session.tasks.find(t => t.worker === worker && t.status === 'dispatched');
  if (existing) {
    existing.brief = brief || existing.brief;
    touchExpiry(session);
    writeSessions(sessions);
    return existing;
  }

  const task = {
    taskId: `t_${Date.now()}_${worker}`,
    worker,
    workerOpenId,
    workerName,
    brief: brief || '',
    status: 'dispatched',
    dispatchedAt: new Date().toISOString(),
    completedAt: null,
  };
  session.tasks.push(task);
  touchExpiry(session);
  writeSessions(sessions);
  return task;
}

function completeTask(chatId, workerOpenId) {
  const sessions = readSessions();
  const session = sessions[chatId];
  if (!session) return null;

  const task = session.tasks.find(
    t => t.workerOpenId === workerOpenId && t.status === 'dispatched'
  );
  if (!task) return null;

  task.status = 'completed';
  task.completedAt = new Date().toISOString();
  touchExpiry(session);
  writeSessions(sessions);
  return task;
}

function getActiveTasks(chatId) {
  const session = getSession(chatId);
  if (!session) return [];
  return session.tasks.filter(t => t.status === 'dispatched');
}

function getCompletedTasks(chatId) {
  const session = getSession(chatId);
  if (!session) return [];
  return session.tasks.filter(t => t.status === 'completed');
}

function findActiveTaskForWorker(workerOpenId) {
  const sessions = readSessions();
  cleanup(sessions);
  for (const [chatId, session] of Object.entries(sessions)) {
    const task = session.tasks.find(
      t => t.workerOpenId === workerOpenId && t.status === 'dispatched'
    );
    if (task) {
      return { chatId, session, task };
    }
  }
  return null;
}

function endSession(chatId) {
  const sessions = readSessions();
  delete sessions[chatId];
  writeSessions(sessions);
}

function isAllCompleted(chatId) {
  const session = getSession(chatId);
  if (!session || session.tasks.length === 0) return false;
  return session.tasks.every(t => t.status === 'completed');
}

const MAX_MESSAGE_LOG = 50;

function logMessage(chatId, agentId, agentName, content) {
  const sessions = readSessions();
  const session = sessions[chatId];
  if (!session) return;

  if (!session.messageLog) session.messageLog = [];

  const summary = content
    .replace(/<at[^>]*>[^<]*<\/at>\s*(\([^)]*\))?/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .substring(0, 150);

  session.messageLog.push({
    timestamp: new Date().toISOString(),
    agentId,
    agentName,
    summary,
  });

  if (session.messageLog.length > MAX_MESSAGE_LOG) {
    session.messageLog = session.messageLog.slice(-MAX_MESSAGE_LOG);
  }

  touchExpiry(session);
  writeSessions(sessions);
}

function getRecentMessages(chatId, limit) {
  const session = getSession(chatId);
  if (!session || !session.messageLog) return [];
  const log = session.messageLog;
  return limit ? log.slice(-limit) : log;
}

module.exports = {
  getSession,
  getAllSessions,
  createSession,
  addTask,
  completeTask,
  getActiveTasks,
  getCompletedTasks,
  findActiveTaskForWorker,
  endSession,
  isAllCompleted,
  logMessage,
  getRecentMessages,
};
