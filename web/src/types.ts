export type Role = "user" | "admin";
export type UserStatus = "active" | "disabled";
export type ContentKind = "word" | "sentence";
export type ContentStatus = "draft" | "published" | "archived";
export type OrderMode = "order" | "shuffle" | "mistakes";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
}

export interface SessionResponse {
  user: User | null;
  csrfToken: string;
}

export interface ContentCategory {
  id: string;
  slug?: string;
  name: string;
  kind: ContentKind;
  sortOrder: number;
  status?: ContentStatus;
  active?: boolean;
}

export interface ContentItem {
  id: string;
  key: string;
  kind: ContentKind;
  categoryId: string;
  english: string;
  meaning: string;
  pronunciation: string;
  sortOrder: number;
  revision: number;
  status?: ContentStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentResponse {
  version: number | string;
  categories: ContentCategory[];
  items: ContentItem[];
}

export interface PracticeSession {
  id: string;
  startedAt: string;
}

export interface AttemptSummary {
  totalAttempts?: number;
  correctAttempts?: number;
  firstTryCorrectCount?: number;
  accuracy?: number;
  currentStreak?: number;
  bestStreak?: number;
  durationMs?: number;
  mistakeCount?: number;
  lastAttempt?: {
    id: string;
    correct: boolean;
    firstTryCorrect: boolean;
  };
  [key: string]: unknown;
}

export interface AttemptResponse {
  attempt?: {
    clientAttemptId: string;
    itemId: string;
    itemRevision: number;
    correct: boolean;
    completedAt: string;
  };
  correct?: boolean;
  expected?: string;
  summary: AttemptSummary;
}

export interface PageContext {
  user: User;
  renderShell: (content: string, activeRoute: "/practice" | "/admin") => void;
  navigate: (path: string, replace?: boolean) => void;
  onUserChanged: (user: User) => void;
  handleAuthError: (error: unknown) => boolean;
}

export interface MistakeRecord {
  item: ContentItem;
  wrongCount: number;
  lastWrongAt: string;
}

export interface MistakesResponse {
  items: MistakeRecord[];
}

export interface ImportMistakesResponse {
  imported: number;
  unmatched: string[] | number;
  alreadyImported: boolean;
}

export interface AdminUserListResponse {
  users: User[];
}

export interface AdminUserMutationResponse {
  user: User;
  temporaryPassword?: string;
}

export interface AdminCategoryListResponse {
  categories: ContentCategory[];
}

export interface AdminItemListResponse {
  items: ContentItem[];
}

export interface AdminStats {
  totalUsers?: number;
  activeUsers?: number;
  totalAttempts?: number;
  activeToday?: number;
  accuracy?: number;
  [key: string]: unknown;
}

export interface AdminStatsResponse {
  stats?: AdminStats;
  [key: string]: unknown;
}

export interface AuditRecord {
  id: string | number;
  action: string;
  actorUsername?: string;
  targetType?: string;
  targetId?: string;
  details?: unknown;
  metadata?: unknown;
  createdAt: string;
}

export interface AuditResponse {
  entries?: AuditRecord[];
  audit?: AuditRecord[];
  items?: AuditRecord[];
}

export interface ImportPreviewRow {
  row?: number;
  category?: string;
  categoryId?: string;
  english?: string;
  meaning?: string;
  pronunciation?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ImportPreviewResponse {
  importId: string;
  rows: ImportPreviewRow[];
  errors: Array<string | { row?: number; message?: string }>;
  summary?: Record<string, unknown>;
}
