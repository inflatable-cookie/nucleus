/** Two distinct recent work items establish an active project under Spec 026. */
export function recentProjectActivity(projects: ReadonlyArray<{ key: string }>, at: string = new Date().toISOString()) {
  return projects.map(project => ({
    key: project.key,
    items: [`${project.key}-a`, `${project.key}-b`].map(id => ({ id, at, executing: false })),
  }));
}
