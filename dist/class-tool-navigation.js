export function resolveClassToolDestination(classes) {
  const activeClasses = Array.isArray(classes) ? classes.filter((entry) => entry && !entry.archivedAt) : [];
  if (!activeClasses.length) return { kind: "create" };
  if (activeClasses.length === 1) return { kind: "open", classItem: activeClasses[0] };
  return { kind: "choose", classes: activeClasses };
}
