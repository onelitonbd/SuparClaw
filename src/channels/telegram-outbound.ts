import type { TelegramMediaUpload } from "../agent/telegram-media.js";

/** Small structural slice of grammY's API, kept easy to fake in tests. */
export interface TelegramMediaApi {
  sendPhoto(chatId: number, photo: unknown, other?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number }>;
  sendVideo(chatId: number, video: unknown, other?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number }>;
  sendAudio(chatId: number, audio: unknown, other?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number }>;
  sendVoice(chatId: number, voice: unknown, other?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number }>;
  sendAnimation(chatId: number, animation: unknown, other?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number }>;
  sendDocument(chatId: number, document: unknown, other?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number }>;
}

/** Upload one already-validated file through the matching Telegram Bot API method. */
export async function sendTelegramMedia(
  api: TelegramMediaApi,
  chatId: number,
  file: TelegramMediaUpload,
  inputFile: unknown,
  messageThreadId?: number,
): Promise<{ messageId: number }> {
  const extra = file.caption || messageThreadId !== undefined
    ? { ...(file.caption ? { caption: file.caption } : {}), ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}) }
    : undefined;
  let sent: { message_id: number };
  switch (file.kind) {
    case "photo": sent = await api.sendPhoto(chatId, inputFile, extra); break;
    case "video": sent = await api.sendVideo(chatId, inputFile, extra); break;
    case "audio": sent = await api.sendAudio(chatId, inputFile, extra); break;
    case "voice": sent = await api.sendVoice(chatId, inputFile, extra); break;
    case "animation": sent = await api.sendAnimation(chatId, inputFile, extra); break;
    case "document": sent = await api.sendDocument(chatId, inputFile, extra); break;
  }
  return { messageId: sent.message_id };
}
