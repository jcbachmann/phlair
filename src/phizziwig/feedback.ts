// Feedback on the editor: the toolbar's feedback button opens Phorge's form
// for a new task in a new tab, filled in with a title, questions and what
// helps to find a problem (the version, the page, the browser). Screenshots
// can be pasted into its description; the task is created when it is sent.

/** Where the form for feedback opens: with the project of feedback tasks, if the build has one. */
export function feedbackUrl(project = __FEEDBACK_PROJECT__): string {
  const description = [
    "//What did you do, what happened, and what did you expect? Or what would you like the editor to do?//",
    "",
    "",
    "",
    "//Screenshots help: paste them here.//",
    "",
    "== Details ==",
    "",
    `- Editor: Phizziwig ${__BUILD__} (${__TARGET__})`,
    `- Page: ${location.href}`,
    `- Browser: ${navigator.userAgent}`,
  ].join("\n");
  const url = new URL("/maniphest/task/edit/form/default/", location.origin);
  url.searchParams.set("title", "Phizziwig feedback: ");
  url.searchParams.set("description", description);
  if (project) {
    url.searchParams.set("projects", project);
  }
  return url.toString();
}
