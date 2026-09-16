import Foundation

public enum CaptureQueryParser {
  public static func parse(
    _ input: String,
    timeZone: TimeZone = .current,
    createdAt: Date = Date()
  ) throws -> CaptureCommand {
    let fields = input
      .split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
      .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let title = fields.first, !title.isEmpty else {
      throw CompanionError.invalidTitle
    }
    let note = fields.count > 1 && !fields[1].isEmpty ? fields[1] : nil
    let scheduledAt = fields.count > 2 && !fields[2].isEmpty
      ? try parseDate(fields[2], timeZone: timeZone)
      : nil
    return CaptureCommand(
      title: title,
      note: note,
      scheduledAt: scheduledAt,
      createdAt: createdAt
    )
  }

  private static func parseDate(_ value: String, timeZone: TimeZone) throws -> Date {
    if let iso = OmniPlanDateCoding.date(from: value) {
      return iso
    }
    for format in ["yyyy-MM-dd HH:mm", "yyyy-MM-dd H:mm", "yyyy-MM-dd"] {
      let formatter = DateFormatter()
      formatter.calendar = Calendar(identifier: .gregorian)
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.timeZone = timeZone
      formatter.dateFormat = format
      formatter.isLenient = false
      if let date = formatter.date(from: value) {
        return date
      }
    }
    throw CompanionError.invalidRemoteData(
      "Plan time must use YYYY-MM-DD HH:mm or ISO-8601."
    )
  }
}
