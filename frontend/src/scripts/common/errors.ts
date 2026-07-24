export function formatApiErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail.map(item => {
      if (item && typeof item === "object") {
        const record = item as { loc?: unknown; msg?: unknown; type?: unknown };
        const location = Array.isArray(record.loc) ? record.loc.join(".") : "";
        const message = typeof record.msg === "string" ? record.msg : JSON.stringify(item);
        return location ? `${location}: ${message}` : message;
      }
      return String(item);
    }).join("; ");
  }
  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }
  return "";
}

export function getApiError(response: Response): Promise<string> {
  return response.text().then(body => {
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      return (
        formatApiErrorDetail(parsed.detail)
        || body
        || `Request failed with status ${response.status}`
      );
    } catch {
      return body || `Request failed with status ${response.status}`;
    }
  });
}
