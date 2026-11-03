/** One path component, not a shell or solver syntax policy; preserve spelling verbatim. */
export function isProjectComponent(project: string): boolean {
  return project.length > 0 && project !== "." && project !== ".." && !/[\\/\0]/u.test(project);
}
