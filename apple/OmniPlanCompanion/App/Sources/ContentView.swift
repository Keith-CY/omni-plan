import SwiftUI

struct ContentView: View {
  @StateObject private var model = CompanionViewModel()

  var body: some View {
    NavigationStack {
      Form {
        Section("Shortcut status") {
          LabeledContent("Pending encrypted captures", value: String(model.pendingCount))
          Text(model.status)
            .font(.callout)
            .foregroundStyle(.secondary)
          Button("Retry pending captures") {
            model.flush()
          }
          .disabled(model.isBusy || model.pendingCount == 0)
        }

        Section("Encrypted Firebase workspace") {
          TextField("Firebase Project ID", text: $model.projectId)
            .textContentType(.organizationName)
          SecureField("Firebase Web API key", text: $model.apiKey)
            .textContentType(.password)
          TextField("Database ID", text: $model.databaseId)
          TextField("Collection path", text: $model.collectionPath)
          TextField("Workspace ID", text: $model.workspaceId)
          SecureField(
            model.hasStoredPassphrase
              ? "Workspace passphrase (leave blank to keep saved value)"
              : "Workspace passphrase",
            text: $model.passphrase
          )
          .textContentType(.password)
          Text(model.credentialStorageDescription)
            .font(.footnote)
            .foregroundStyle(.secondary)
          Button(model.isBusy ? "Checking…" : "Save and test encrypted sync") {
            model.saveAndTest()
          }
          .disabled(model.isBusy)
        }

        Section("Test Add Action") {
          TextField("Title", text: $model.testTitle)
          TextField("Note (optional)", text: $model.testNote, axis: .vertical)
            .lineLimit(2...4)
          Toggle("Set a plan time", isOn: $model.testHasPlanTime)
          if model.testHasPlanTime {
            DatePicker(
              "Plan time",
              selection: $model.testPlanTime,
              displayedComponents: [.date, .hourAndMinute]
            )
          }
          Button("Add Action in background") {
            model.captureTestAction()
          }
          .disabled(model.isBusy || model.testTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .formStyle(.grouped)
      .navigationTitle("OmniPlan Companion")
      .task {
        model.load()
      }
    }
    #if os(macOS)
    .frame(minWidth: 560, idealWidth: 620, minHeight: 600, idealHeight: 720)
    #endif
  }
}
