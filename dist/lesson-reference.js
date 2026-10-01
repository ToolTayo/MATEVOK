/** Select the most relevant saved lesson for a class-day without mutating records. */
function mostRecentlyUpdated(lessons) {
  return lessons.slice().sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) ||
    String(left.title || "").localeCompare(String(right.title || ""), undefined, { sensitivity: "base" }) ||
    String(left.id || "").localeCompare(String(right.id || ""))
  )[0] || null;
}

export function selectLessonReference({ classId, lessons = [], localDate = "" } = {}) {
  if (typeof classId !== "string" || !classId) return Object.freeze({ lesson: null, scheduledToday: false });
  const classLessons = (Array.isArray(lessons) ? lessons : []).filter((lesson) => lesson && lesson.classId === classId && typeof lesson.title === "string");
  const scheduledToday = typeof localDate === "string" && localDate
    ? classLessons.filter((lesson) => lesson.date === localDate)
    : [];
  const lesson = mostRecentlyUpdated(scheduledToday.length ? scheduledToday : classLessons);
  return Object.freeze({ lesson, scheduledToday: Boolean(lesson && scheduledToday.length) });
}
