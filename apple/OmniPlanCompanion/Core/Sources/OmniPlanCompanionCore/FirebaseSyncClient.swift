import Foundation

public protocol HTTPTransporting: Sendable {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public final class URLSessionHTTPTransport: HTTPTransporting, @unchecked Sendable {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw CompanionError.transport("Firebase returned a non-HTTP response.")
    }
    return (data, http)
  }
}

public protocol WorkspaceSyncing: Sendable {
  func pull(passphrase: String) async throws -> PulledWorkspace
  func push(
    workspace: [String: Any],
    previousManifest: FirebaseE2EEManifest?,
    passphrase: String
  ) async throws -> PushedWorkspace
}

public final class FirebaseWorkspaceSyncClient: WorkspaceSyncing, @unchecked Sendable {
  private struct FirestoreDocument: Decodable {
    let fields: [String: FirestoreValue]?
    let updateTime: String?
  }

  private struct FirestoreValue: Decodable {
    let stringValue: String?
  }

  private struct SignInResponse: Decodable {
    let idToken: String
    let refreshToken: String?
    let localId: String
    let expiresIn: String?
  }

  private let configuration: CompanionConfiguration
  private let deviceId: String
  private let transport: HTTPTransporting

  public init(
    configuration: CompanionConfiguration,
    deviceId: String,
    transport: HTTPTransporting = URLSessionHTTPTransport()
  ) {
    self.configuration = configuration.normalized
    self.deviceId = deviceId
    self.transport = transport
  }

  public func pull(passphrase: String) async throws -> PulledWorkspace {
    let session = try await signInAnonymously()
    guard let manifest = try await readManifest(session: session) else {
      throw CompanionError.remoteWorkspaceMissing
    }
    try validateManifest(manifest)
    guard let envelope = try await readEnvelope(session: session) else {
      throw CompanionError.remoteWorkspaceMissing
    }
    guard envelope.revision == manifest.latestRevision else {
      throw CompanionError.syncConflict
    }
    try validateWorkspaceSchema(envelope.workspaceSchemaVersion)
    let workspace = try SyncCrypto.decryptWorkspace(envelope.payload, passphrase: passphrase)
    try WorkspaceMutation.validate(workspace)
    let checksum = CanonicalJSON.sha256Hex(try CanonicalJSON.data(workspace))
    guard checksum == envelope.plaintextChecksum else {
      throw CompanionError.checksumMismatch
    }
    return PulledWorkspace(manifest: manifest, envelope: envelope, json: workspace)
  }

  public func push(
    workspace: [String: Any],
    previousManifest: FirebaseE2EEManifest?,
    passphrase: String
  ) async throws -> PushedWorkspace {
    try WorkspaceMutation.validate(workspace)
    if let previousManifest {
      try validateManifest(previousManifest)
    }
    let session = try await signInAnonymously()
    let createdAt = OmniPlanDateCoding.string(from: Date())
    let plaintextChecksum = CanonicalJSON.sha256Hex(try CanonicalJSON.data(workspace))
    let revision = CanonicalJSON.sha256Hex(
      "\(previousManifest?.latestRevision ?? "root")\n\(deviceId)\n\(createdAt)\n\(plaintextChecksum)"
    )
    let envelope = FirebaseWorkspaceSnapshotEnvelope(
      schemaVersion: 1,
      workspaceSchemaVersion: WorkspaceMutation.supportedSchemaVersion,
      workspaceId: configuration.workspaceId,
      deviceId: deviceId,
      revision: revision,
      previousRevision: previousManifest?.latestRevision,
      createdAt: createdAt,
      plaintextChecksum: plaintextChecksum,
      payload: try SyncCrypto.encryptWorkspace(workspace, passphrase: passphrase)
    )
    var heads = previousManifest?.heads ?? [:]
    heads[deviceId] = FirebaseManifestHead(revision: revision, updatedAt: createdAt)
    let manifest = FirebaseE2EEManifest(
      schemaVersion: 1,
      workspaceSchemaVersion: WorkspaceMutation.supportedSchemaVersion,
      minimumClientWorkspaceSchemaVersion: WorkspaceMutation.supportedSchemaVersion,
      provider: "firebase-firestore-e2ee",
      workspaceId: configuration.workspaceId,
      latestRevision: revision,
      updatedAt: createdAt,
      updatedByDeviceId: deviceId,
      snapshotDocumentPath: paths.snapshot,
      heads: heads,
      firestoreUpdateTime: nil
    )
    let commitTime = try await commit(
      envelope: envelope,
      manifest: manifest,
      previousManifest: previousManifest,
      session: session
    )
    return PushedWorkspace(manifest: manifest, envelope: envelope, commitTime: commitTime)
  }

  private func signInAnonymously() async throws -> FirebaseAnonymousSession {
    guard let url = URL(
      string: "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=\(encodeQuery(configuration.apiKey))"
    ) else {
      throw CompanionError.missingConfiguration
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["returnSecureToken": true])
    let (data, response) = try await send(request)
    guard (200..<300).contains(response.statusCode) else {
      throw CompanionError.transport("Firebase anonymous sign-in failed (\(response.statusCode)).")
    }
    let payload = try JSONDecoder().decode(SignInResponse.self, from: data)
    return FirebaseAnonymousSession(
      idToken: payload.idToken,
      refreshToken: payload.refreshToken,
      localId: payload.localId,
      expiresIn: payload.expiresIn.flatMap(Int.init)
    )
  }

  private func readManifest(session: FirebaseAnonymousSession) async throws -> FirebaseE2EEManifest? {
    guard let document = try await readDocument(path: paths.manifest, session: session) else {
      return nil
    }
    guard let json = document.fields?["manifestJson"]?.stringValue,
          let data = json.data(using: .utf8)
    else {
      throw CompanionError.invalidRemoteData("Manifest JSON is missing.")
    }
    var manifest = try JSONDecoder().decode(FirebaseE2EEManifest.self, from: data)
    manifest.firestoreUpdateTime = document.updateTime
    return manifest
  }

  private func readEnvelope(session: FirebaseAnonymousSession) async throws -> FirebaseWorkspaceSnapshotEnvelope? {
    guard let document = try await readDocument(path: paths.snapshot, session: session) else {
      return nil
    }
    guard let json = document.fields?["envelopeJson"]?.stringValue,
          let data = json.data(using: .utf8)
    else {
      throw CompanionError.invalidRemoteData("Snapshot envelope JSON is missing.")
    }
    return try JSONDecoder().decode(FirebaseWorkspaceSnapshotEnvelope.self, from: data)
  }

  private func readDocument(
    path: String,
    session: FirebaseAnonymousSession
  ) async throws -> FirestoreDocument? {
    guard let url = URL(string: "\(documentsBaseURL)/\(encodePath(path))") else {
      throw CompanionError.missingConfiguration
    }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(session.idToken)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await send(request)
    if response.statusCode == 404 {
      return nil
    }
    guard (200..<300).contains(response.statusCode) else {
      throw CompanionError.transport("Firebase read failed (\(response.statusCode)).")
    }
    return try JSONDecoder().decode(FirestoreDocument.self, from: data)
  }

  private func commit(
    envelope: FirebaseWorkspaceSnapshotEnvelope,
    manifest: FirebaseE2EEManifest,
    previousManifest: FirebaseE2EEManifest?,
    session: FirebaseAnonymousSession
  ) async throws -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let envelopeJson = String(decoding: try encoder.encode(envelope), as: UTF8.self)
    let manifestJson = String(decoding: try encoder.encode(manifest), as: UTF8.self)
    let manifestPrecondition: [String: Any]
    if let previousManifest {
      guard let updateTime = previousManifest.firestoreUpdateTime else {
        throw CompanionError.syncConflict
      }
      manifestPrecondition = ["updateTime": updateTime]
    } else {
      manifestPrecondition = ["exists": false]
    }

    let writes: [[String: Any]] = [
      updateWrite(
        path: paths.snapshot,
        fields: [
          "schemaVersion": integerValue(1),
          "workspaceSchemaVersion": integerValue(WorkspaceMutation.supportedSchemaVersion),
          "workspaceId": stringValue(configuration.workspaceId),
          "revision": stringValue(envelope.revision),
          "updatedAt": stringValue(envelope.createdAt),
          "envelopeJson": stringValue(envelopeJson)
        ]
      ),
      updateWrite(
        path: joinPath(paths.operationDirectory, envelope.revision),
        fields: [
          "schemaVersion": integerValue(1),
          "workspaceSchemaVersion": integerValue(WorkspaceMutation.supportedSchemaVersion),
          "workspaceId": stringValue(configuration.workspaceId),
          "deviceId": stringValue(deviceId),
          "revision": stringValue(envelope.revision),
          "previousRevision": stringValue(envelope.previousRevision ?? ""),
          "createdAt": stringValue(envelope.createdAt),
          "envelopeJson": stringValue(envelopeJson)
        ],
        currentDocument: ["exists": false]
      ),
      updateWrite(
        path: paths.manifest,
        fields: [
          "schemaVersion": integerValue(1),
          "workspaceSchemaVersion": integerValue(WorkspaceMutation.supportedSchemaVersion),
          "workspaceId": stringValue(configuration.workspaceId),
          "latestRevision": stringValue(manifest.latestRevision),
          "updatedAt": stringValue(manifest.updatedAt),
          "manifestJson": stringValue(manifestJson)
        ],
        currentDocument: manifestPrecondition
      )
    ]
    guard let url = URL(string: "\(documentsBaseURL):commit") else {
      throw CompanionError.missingConfiguration
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(session.idToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["writes": writes])
    let (data, response) = try await send(request)
    guard (200..<300).contains(response.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      if response.statusCode == 409 ||
          body.contains("FAILED_PRECONDITION") ||
          body.contains("ABORTED") {
        throw CompanionError.syncConflict
      }
      throw CompanionError.transport("Firebase commit failed (\(response.statusCode)).")
    }
    let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    return payload?["commitTime"] as? String
  }

  private func updateWrite(
    path: String,
    fields: [String: Any],
    currentDocument: [String: Any]? = nil
  ) -> [String: Any] {
    var write: [String: Any] = [
      "update": [
        "name": documentName(path),
        "fields": fields
      ]
    ]
    if let currentDocument {
      write["currentDocument"] = currentDocument
    }
    return write
  }

  private func validateManifest(_ manifest: FirebaseE2EEManifest) throws {
    guard manifest.schemaVersion == 1,
          manifest.provider == "firebase-firestore-e2ee",
          manifest.workspaceId == configuration.workspaceId
    else {
      throw CompanionError.invalidRemoteData("Manifest identity is invalid.")
    }
    try validateWorkspaceSchema(manifest.workspaceSchemaVersion)
    try validateWorkspaceSchema(manifest.minimumClientWorkspaceSchemaVersion)
  }

  private func validateWorkspaceSchema(_ version: Int?) throws {
    if let version, version > WorkspaceMutation.supportedSchemaVersion {
      throw CompanionError.futureWorkspaceSchema(version)
    }
  }

  private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
      return try await transport.data(for: request)
    } catch let error as CompanionError {
      throw error
    } catch {
      throw CompanionError.transport("Network request failed: \(error.localizedDescription)")
    }
  }

  private var paths: (manifest: String, snapshot: String, operationDirectory: String) {
    let root = joinPath(configuration.collectionPath, configuration.workspaceId)
    return (
      joinPath(root, "manifest", "current"),
      joinPath(root, "snapshots", "latest"),
      joinPath(root, "ops")
    )
  }

  private var documentsBaseURL: String {
    "https://firestore.googleapis.com/v1/projects/\(encodePathSegment(configuration.projectId))/databases/\(encodePathSegment(configuration.databaseId))/documents"
  }

  private func documentName(_ path: String) -> String {
    "projects/\(encodePathSegment(configuration.projectId))/databases/\(encodePathSegment(configuration.databaseId))/documents/\(encodePath(path))"
  }

  private func joinPath(_ parts: String...) -> String {
    parts
      .flatMap { $0.split(separator: "/") }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: "/")
  }

  private func encodePath(_ path: String) -> String {
    path
      .split(separator: "/")
      .map { encodePathSegment(String($0)) }
      .joined(separator: "/")
  }

  private func encodePathSegment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
  }

  private func encodeQuery(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
  }

  private func stringValue(_ value: String) -> [String: Any] {
    ["stringValue": value]
  }

  private func integerValue(_ value: Int) -> [String: Any] {
    ["integerValue": String(value)]
  }
}
