const NEGATED = /\b(?:do not|don't|dont|never|not yet|hold off on|without)\b[^.!?]{0,140}\b(?:send|email|trash|delete|remove|restore|archive|label|mark|move|modify|update|create)\b/;
const MAILBOX_CONTEXT = /\b(?:gmail|e-?mail|mailbox|message|thread|draft|inbox|trash|spam|label|labels|unread|read|starred|recipient|reply)\b/;

/** Conservative current-turn intent gates for Gmail side effects. */
export function gmailSendRequested(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || NEGATED.test(normalized) || !MAILBOX_CONTEXT.test(normalized)) return false;
  return /\b(?:send|email|deliver)\b/.test(normalized);
}

export function gmailMutationRequested(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || NEGATED.test(normalized) || !MAILBOX_CONTEXT.test(normalized)) return false;
  return /\b(?:trash|delete|remove|restore|untrash|archive|label|mark\s+(?:as\s+)?(?:read|unread|important|spam)|star|unstar|apply|rename|create\s+(?:a\s+)?label|update\s+(?:the\s+)?label|change\s+(?:the\s+)?label|move\s+(?:the\s+)?(?:message|thread|email|emails))\b/.test(normalized);
}

export function gmailDraftDeleteRequested(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || NEGATED.test(normalized)) return false;
  return /\b(?:delete|remove|discard)\b[^.!?]{0,100}\bdraft\b|\bdraft\b[^.!?]{0,100}\b(?:delete|remove|discard)\b/.test(normalized);
}
