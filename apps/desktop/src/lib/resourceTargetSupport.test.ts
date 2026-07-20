import { describe, expect, test } from "bun:test";
import type { ControlProjectRecordDto, ControlProjectResourceRecordDto } from "./control";
import { resourceTargetPresentation } from "./resourceTargetSupport";

describe("resourceTargetPresentation", () => {
  test("keeps zero and one healthy resource quiet", () => {
    expect(resourceTargetPresentation(project([]), null).show).toBe(false);
    const one = resourceTargetPresentation(project([resource("resource:one")]), null);
    expect(one.show).toBe(false);
    expect(one.selectedResourceId).toBe("resource:one");
  });

  test("shows a selector only when resource choice or repair is relevant", () => {
    const multipleProject = project([resource("resource:one"), resource("resource:two")]);
    multipleProject.default_working_resource_id = "resource:one";
    const multiple = resourceTargetPresentation(multipleProject, "resource:two");
    expect(multiple.show).toBe(true);
    expect(multiple.showSelector).toBe(true);
    expect(multiple.selectedResourceId).toBe("resource:two");
    expect(resourceTargetPresentation(multipleProject, null).selectedResourceId).toBe(
      "resource:one",
    );

    const repair = resourceTargetPresentation(
      project([resource("resource:missing", "missing")]),
      null,
    );
    expect(repair.show).toBe(true);
    expect(repair.showSelector).toBe(false);
    expect(repair.repairCount).toBe(1);
  });

  test("ignores reference resources and keeps unavailable working targets visible for repair", () => {
    const referenceOnly = resourceTargetPresentation(
      project([resource("resource:reference", "present", "reference")]),
      null,
    );
    expect(referenceOnly.show).toBe(false);
    expect(referenceOnly.selectedResourceId).toBeNull();

    const unavailable = resource("resource:unavailable");
    unavailable.locator_available = false;
    const mixed = resourceTargetPresentation(
      project([unavailable, resource("resource:available")]),
      "resource:unavailable",
    );
    expect(mixed.show).toBe(true);
    expect(mixed.showSelector).toBe(true);
    expect(mixed.selectedResourceId).toBe("resource:unavailable");
    expect(mixed.repairCount).toBe(1);
  });
});

function project(resources: ControlProjectResourceRecordDto[]): ControlProjectRecordDto {
  return {
    project_id: "project:test",
    display_name: "Test",
    authority_host_ref: "host:embedded-desktop",
    status: "active",
    retention: "durable",
    importance_level: "normal",
    revision_id: "rev:test",
    resource_count: resources.length,
    repository_count: 0,
    default_working_resource_id: null,
    management_resource_id: null,
    management_sync_policy: null,
    management_projection_status: null,
    location_status: resources.length === 0 ? "not_recorded" : "present",
    resources,
  };
}

function resource(
  resourceId: string,
  status: ControlProjectResourceRecordDto["location_status"] = "present",
  role: ControlProjectResourceRecordDto["role"] = "working",
): ControlProjectResourceRecordDto {
  return {
    resource_id: resourceId,
    display_name: resourceId,
    kind: "filesystem_folder",
    role,
    authority_host_ref: "host:embedded-desktop",
    location_status: status,
    locator_available: status === "present",
    default_branch: null,
    is_default_working_resource: false,
    is_management_resource: false,
  };
}
