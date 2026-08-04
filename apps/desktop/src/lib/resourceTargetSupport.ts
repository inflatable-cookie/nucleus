import type {
  ControlProjectRecordDto,
  ControlProjectResourceRecordDto,
} from "./control";

export type ResourceTargetPresentation = {
  show: boolean;
  showSelector: boolean;
  selectedResourceId: string | null;
  repairCount: number;
  workingResources: ControlProjectResourceRecordDto[];
};

export function effectiveResourceTarget(
  project: ControlProjectRecordDto,
  explicitResourceId: string | null,
): string | null {
  if (explicitResourceId) return explicitResourceId;
  if (project.default_working_resource_id) return project.default_working_resource_id;
  const availableResources = project.resources.filter(
    (resource) => resource.role === "working" && resourceIsAvailable(resource),
  );
  return availableResources.length === 1 ? availableResources[0].resource_id : null;
}

export function resourceTargetPresentation(
  project: ControlProjectRecordDto,
  explicitResourceId: string | null,
): ResourceTargetPresentation {
  const workingResources = project.resources.filter((resource) => resource.role === "working");
  const availableResources = workingResources.filter(resourceIsAvailable);
  const repairCount = workingResources.length - availableResources.length;
  return {
    show: availableResources.length > 1 || repairCount > 0,
    showSelector: workingResources.length > 1,
    selectedResourceId: effectiveResourceTarget(project, explicitResourceId),
    repairCount,
    workingResources,
  };
}

export function resourceIsAvailable(resource: ControlProjectResourceRecordDto): boolean {
  return resource.location_status === "present" && resource.locator_available;
}
