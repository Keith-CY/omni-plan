import Foundation
import Testing
@testable import OmniPlanCompanionCore

@Test
func unscheduledCaptureStaysInInbox() throws {
  var workspace = emptyWorkspace()
  let command = CaptureCommand(
    id: "capture-one",
    title: "  Capture this  ",
    note: "  Context  ",
    createdAt: Date(timeIntervalSince1970: 1_800_000_000)
  )

  let applied = try WorkspaceMutation.add(commands: [command], to: &workspace)
  let todo = try #require((workspace["todos"] as? [[String: Any]])?.first)

  #expect(applied == ["capture-one"])
  #expect(todo["id"] as? String == "todo-shortcut-capture-one")
  #expect(todo["title"] as? String == "Capture this")
  #expect(todo["note"] as? String == "Context")
  #expect(todo["inbox"] as? Bool == true)
  #expect(todo["scheduledAt"] == nil)
}

@Test
func scheduledCaptureLeavesInboxAndIsIdempotent() throws {
  var workspace = emptyWorkspace()
  let scheduledAt = Date(timeIntervalSince1970: 1_800_003_600)
  let command = CaptureCommand(
    id: "capture-two",
    title: "Scheduled work",
    scheduledAt: scheduledAt,
    createdAt: Date(timeIntervalSince1970: 1_800_000_000)
  )

  _ = try WorkspaceMutation.add(commands: [command], to: &workspace)
  _ = try WorkspaceMutation.add(commands: [command], to: &workspace)
  let todos = try #require(workspace["todos"] as? [[String: Any]])

  #expect(todos.count == 1)
  #expect(todos[0]["inbox"] as? Bool == false)
  #expect(todos[0]["scheduledAt"] as? String == OmniPlanDateCoding.string(from: scheduledAt))
  #expect(WorkspaceMutation.alreadyAppliedCommandIds([command], in: workspace) == ["capture-two"])
}

private func emptyWorkspace() -> [String: Any] {
  [
    "schemaVersion": 3,
    "timeZone": "Asia/Tokyo",
    "todos": [Any](),
    "conversionHistory": [Any](),
    "projects": [Any](),
    "workItems": [Any](),
    "recurringOccurrences": [Any](),
    "dependencies": [Any](),
    "resources": [Any](),
    "capacities": [Any](),
    "baselines": [Any](),
    "actuals": [Any](),
    "evidence": [Any](),
    "decisions": [Any](),
    "changeSets": [Any](),
    "auditGates": [Any](),
    "auditDecisions": [Any]()
  ]
}

@Test
func parsesAlfredQuickAndDetailedQueries() throws {
  let timeZone = try #require(TimeZone(identifier: "Asia/Tokyo"))
  let quick = try CaptureQueryParser.parse("Buy milk", timeZone: timeZone)
  let detailed = try CaptureQueryParser.parse(
    "Buy milk | Use the coupon | 2026-08-01 15:00",
    timeZone: timeZone
  )

  #expect(quick.title == "Buy milk")
  #expect(quick.note == nil)
  #expect(quick.scheduledAt == nil)
  #expect(detailed.note == "Use the coupon")
  #expect(OmniPlanDateCoding.string(from: try #require(detailed.scheduledAt)) == "2026-08-01T06:00:00.000Z")
}
