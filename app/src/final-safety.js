// Shared service projection: relationship-agent safety is already reviewed;
// legacy protocols also retain the service's explicit-answer fallback.
export function finalSafety(context, result, protocol) {
  return result.assessment.safety || (protocol !== 'relationship_agent' &&
    context.payload.answers.some(answer => answer.selected.some(option => option.meta.s === 'suicidal') ||
      /죽고\s?싶|사라지고\s?싶|없어지고\s?싶|자살|자해/.test(answer.type === 'text' ? answer.text : answer.custom)));
}
