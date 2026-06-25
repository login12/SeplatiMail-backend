// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: UserDto;
}

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
  hasMailAccount: boolean;
}

// ─── Mail Account ─────────────────────────────────────────────────────────────

export interface SetupMailAccountDto {
  emailAddress: string;
  displayName?: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

// ─── Mail Messages ────────────────────────────────────────────────────────────

export interface MailboxFolder {
  name: string;
  path: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
}

export interface MailListItem {
  uid: number;
  messageId: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  date: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  preview: string; // First ~150 chars of body
  attachments?: MailAttachment[];
}

export interface MailMessage extends MailListItem {
  cc?: MailAddress[];
  bcc?: MailAddress[];
  bodyHtml?: string;   // Sanitized HTML
  bodyText?: string;   // Plain text fallback
  attachments: MailAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  disposition?: string;
  isInline?: boolean;
}

export interface SendMailDto {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiError {
  success: false;
  error: string;
  details?: unknown;
}
