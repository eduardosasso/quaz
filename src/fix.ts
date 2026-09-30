const LINK: RegExp =
  /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|commit)\/\w+/g;

const links = (
  description: string,
  comments: string[],
  repository: string,
): RegExpMatchArray[] =>
  Array.from(
    `${description}\n${JSON.stringify(comments)}`.matchAll(LINK),
  ).filter((entry): boolean => entry[1] === repository);

export const reference = (
  description: string,
  comments: string[],
  repository: string,
): boolean => links(description, comments, repository).length > 0;
