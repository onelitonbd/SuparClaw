const NEGATED = /\b(?:do not|don't|dont|never|not yet|hold off on|without)\b[^.!?]{0,160}\b(?:create|add|edit|update|change|move|trash|delete|remove|clear|share|invite|send)\b|(?:করো না|করবেন না|করিস না|কোরো না)/i;

/** Conservative current-turn intent gates for Google Workspace side effects. */
export function workspaceMutationRequested(text: string): boolean {
  const value = text.trim();
  if (!value || NEGATED.test(value)) return false;
  return /\b(?:create|make|add|write|edit|update|change|format|move|copy|rename|trash|delete|remove|clear|empty|restore|insert|append|batch\s+update|share|permission|invite|schedule|book|cancel|respond|accept|decline|hide|unhide|resolve|reopen|upload|transfer|owner|ownership)\b|(?:তৈরি|লিখে|যোগ|সম্পাদনা|আপডেট|পরিবর্তন|মুছে|ডিলিট|শেয়ার|শেয়ার|আমন্ত্রণ|সিডিউল|শিডিউল)/i.test(value);
}

export function workspaceDeleteRequested(text: string): boolean {
  const value = text.trim();
  if (!value || NEGATED.test(value)) return false;
  return /\b(?:delete|remove|permanently\s+remove|trash|cancel)\b[^.!?]{0,100}\b(?:document|doc|spreadsheet|sheet|range|cells|file|drive|calendar|event|meeting|trash|comment|permission|reply|table|row|column|tab|chart|text|content|paragraph)\b|\b(?:document|doc|spreadsheet|sheet|range|cells|file|drive|calendar|event|meeting|trash|comment|permission|reply|table|row|column|tab|chart|text|content|paragraph)\b[^.!?]{0,100}\b(?:delete|remove|trash|cancel)\b|\b(?:empty\s+(?:the\s+)?trash|clear\s+(?:the\s+)?(?:calendar|sheet|spreadsheet|range|cells|document)|delete\s+(?:the\s+)?calendar)\b|(?:মুছে ফেল|ডিলিট কর)/i.test(value);
}

export function workspaceShareRequested(text: string): boolean {
  const value = text.trim();
  if (!value || NEGATED.test(value)) return false;
  return /\b(?:share|sharing|permission|permissions|access|owner|ownership)\b|(?:শেয়ার|শেয়ার|অনুমতি|অ্যাক্সেস)/i.test(value);
}

export function workspacePublicShareRequested(text: string): boolean {
  const value = text.trim();
  if (!workspaceShareRequested(value)) return false;
  return /\b(?:public|anyone|everyone|world|link|owner|ownership|transfer)\b|সবার/i.test(value);
}

export function workspaceInviteRequested(text: string): boolean {
  const value = text.trim();
  if (!value || NEGATED.test(value)) return false;
  return /\b(?:invite|invitation|attendee|attendees|send\s+(?:the\s+)?invite|notify|email\s+(?:the\s+)?attendees)\b|(?:আমন্ত্রণ|ইনভাইট|অতিথি)/i.test(value);
}
