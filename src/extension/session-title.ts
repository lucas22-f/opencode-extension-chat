const defaultTitle = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultSessionTitle(title: string): boolean {
  return defaultTitle.test(title);
}

export function sessionTopicTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  const normalized = firstLine.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return Array.from(normalized).slice(0, 80).join("");
}
