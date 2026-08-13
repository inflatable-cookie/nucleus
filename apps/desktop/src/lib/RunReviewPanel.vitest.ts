import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliveredRunReview, rejectedRunReview, reviewPatchFixture } from "./runReviewPanel.fixture";

const queryOrchestrationRunReview = vi.hoisted(() => vi.fn());
const queryOrchestrationRunReviewPatch = vi.hoisted(() => vi.fn());
const submitRunTransition = vi.hoisted(() => vi.fn());

vi.mock("./control/runFleet", () => ({
  queryOrchestrationRunReview,
  queryOrchestrationRunReviewPatch,
  submitRunTransition,
}));

import RunReviewPanel from "./RunReviewPanel.svelte";

afterEach(() => cleanup());

beforeEach(() => {
  queryOrchestrationRunReview.mockReset();
  queryOrchestrationRunReviewPatch.mockReset();
  submitRunTransition.mockReset();
  queryOrchestrationRunReview.mockResolvedValue({
    state: "record",
    review: deliveredRunReview,
  });
  queryOrchestrationRunReviewPatch.mockResolvedValue({
    state: "record",
    patch: reviewPatchFixture,
  });
  submitRunTransition.mockResolvedValue({ state: "accepted" });
});

describe("RunReviewPanel", () => {
  it("renders closeout, validation result, and the branch diff in one surface", async () => {
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: "run:delivered-worker",
        onOpenThread: vi.fn(),
        onPrepareRework: vi.fn(),
        onReviewed: vi.fn(),
      },
    });

    expect(await screen.findByText("Worker finished the review surface with passing validation.")).toBeTruthy();
    expect(screen.getByText("Validation passed")).toBeTruthy();
    expect(screen.getByText("2 changed files")).toBeTruthy();
    expect(screen.getByText("Committed")).toBeTruthy();
    expect(screen.getByText("Pushed")).toBeTruthy();
    expect(screen.getByText("src/lib/RunReviewPanel.svelte")).toBeTruthy();
    expect(screen.getByText("src/lib/control/runFleet.ts")).toBeTruthy();
    expect(await screen.findByLabelText("Unified diff for src/lib/RunReviewPanel.svelte")).toBeTruthy();
  });

  it("accepts a delivered run through the registry transition and refreshes", async () => {
    const onReviewed = vi.fn();
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: "run:delivered-worker",
        onOpenThread: vi.fn(),
        onPrepareRework: vi.fn(),
        onReviewed,
      },
    });

    await screen.findByText("Worker finished the review surface with passing validation.");
    await fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(submitRunTransition).toHaveBeenCalledWith(
      "run:delivered-worker",
      "accept",
      null,
      null,
    ));
    expect(onReviewed).toHaveBeenCalled();
    expect(queryOrchestrationRunReview).toHaveBeenCalledTimes(2);
  });

  it("rejects a delivered run through the registry transition", async () => {
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: "run:delivered-worker",
        onOpenThread: vi.fn(),
        onPrepareRework: vi.fn(),
        onReviewed: vi.fn(),
      },
    });

    await screen.findByText("Worker finished the review surface with passing validation.");
    await fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(submitRunTransition).toHaveBeenCalledWith(
      "run:delivered-worker",
      "reject",
      null,
      "Rejected by operator review.",
    ));
  });

  it("routes rework for a rejected run through the prepared rework handoff", async () => {
    queryOrchestrationRunReview.mockResolvedValue({
      state: "record",
      review: rejectedRunReview,
    });
    const onPrepareRework = vi.fn();
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: "run:rejected-worker",
        onOpenThread: vi.fn(),
        onPrepareRework,
        onReviewed: vi.fn(),
      },
    });

    await screen.findByText("Worker finished, but acceptance was not met.");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Address changes" }));
    expect(onPrepareRework).toHaveBeenCalled();
  });

  it("opens the worker thread for the run conversation", async () => {
    const onOpenThread = vi.fn();
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: "run:delivered-worker",
        onOpenThread,
        onPrepareRework: vi.fn(),
        onReviewed: vi.fn(),
      },
    });

    await screen.findByText("Worker finished the review surface with passing validation.");
    await fireEvent.click(screen.getByRole("button", { name: "Open worker thread" }));
    expect(onOpenThread).toHaveBeenCalled();
  });

  it("renders an explicit unavailable diff when the base cannot be computed", async () => {
    queryOrchestrationRunReview.mockResolvedValue({
      state: "record",
      review: {
        ...deliveredRunReview,
        diff: {
          base_ref: null,
          available: false,
          unreachable_reason: "run has no recorded diff base",
          files: [],
          truncated: false,
        },
      },
    });
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: "run:delivered-worker",
        onOpenThread: vi.fn(),
        onPrepareRework: vi.fn(),
        onReviewed: vi.fn(),
      },
    });

    expect(await screen.findByText("run has no recorded diff base")).toBeTruthy();
    expect(queryOrchestrationRunReviewPatch).not.toHaveBeenCalled();
  });

  it("renders the no-run boundary without querying", () => {
    const screen = render(RunReviewPanel, {
      props: {
        projectId: "project:one",
        runId: null,
        onOpenThread: vi.fn(),
        onPrepareRework: vi.fn(),
        onReviewed: vi.fn(),
      },
    });

    expect(screen.getByText("Select a delivered run to review its closeout and diff.")).toBeTruthy();
    expect(queryOrchestrationRunReview).not.toHaveBeenCalled();
  });
});
