// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { feedbackUrl } from "../src/phizziwig/feedback";

describe("feedbackUrl", () => {
  it("opens the form for a new task with a title, questions and the details", () => {
    const url = new URL(feedbackUrl(""));
    expect(url.pathname).toBe("/maniphest/task/edit/form/default/");
    expect(url.searchParams.get("title")).toBe("Phizziwig feedback: ");
    expect(url.searchParams.get("description")).toContain(`- Page: ${location.href}`);
    expect(url.searchParams.has("projects")).toBe(false);
  });

  it("gives the task the project of feedback tasks, if there is one", () => {
    expect(new URL(feedbackUrl("phlair")).searchParams.get("projects")).toBe("phlair");
  });
});
