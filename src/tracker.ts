export type Card = {
  id: number;
  version: number;
  title: string;
  description: string;
  checklist: string;
  tags: string;
  status: number;
  comments: string[];
};

export type Attachment = {
  id: number;
  name: string;
};

export type Changes = {
  title?: string;
  description?: string;
  checklist?: string;
  tags?: string;
  tagsAdd?: string;
  tagsRemove?: string;
};

export type Tracker = {
  list: () => Promise<Card[]>;
  get: (id: number) => Promise<Card | null>;
  create: (title: string, key: string) => Promise<Card>;
  recover: (key: string) => Promise<Card | null>;
  update: (id: number, changes: Changes) => Promise<Card>;
  complete: (id: number) => Promise<void>;
  reopen: (id: number) => Promise<void>;
  comment: (id: number, body: string) => Promise<void>;
  upload: (
    id: number,
    path: string,
    bytes: Uint8Array,
    mime: string,
  ) => Promise<Attachment>;
  attachments: (id: number) => Promise<Attachment[]>;
  download: (id: number) => Promise<Uint8Array>;
  attachmentUrl: (id: number) => string;
};
