const LINK: RegExp =
  /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|commit)\/(\w+)/g;

export type Pull = { repository: string; number: string };

const links = (
  description: string,
  comments: string[],
  repository: string,
): RegExpMatchArray[] =>
  Array.from(
    `${description}\n${JSON.stringify(comments)}`.matchAll(LINK),
  ).filter((entry): boolean => entry[1] === repository);

export const pull = (
  description: string,
  comments: string[],
  repository: string,
): Pull | null => {
  const match: RegExpMatchArray | undefined = links(
    description,
    comments,
    repository,
  )
    .filter((entry): boolean => entry[2] === "pull" && /^\d+$/.test(entry[3]))
    .at(-1);

  return match ? { repository: match[1], number: match[3] } : null;
};

export const reference = (
  description: string,
  comments: string[],
  repository: string,
): boolean => links(description, comments, repository).length > 0;
