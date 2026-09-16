import Foundation
import Testing
@testable import OmniPlanCompanionCore

@Test
func canonicalJSONMatchesTheWebStableShape() throws {
  let value: [String: Any] = [
    "todos": [
      ["title": "買い物", "flagged": false, "tags": [String]()]
    ],
    "timeZone": "Asia/Tokyo",
    "schemaVersion": 3
  ]

  let actual = try CanonicalJSON.string(value)
  #expect(
    actual ==
      #"{"schemaVersion":3,"timeZone":"Asia/Tokyo","todos":[{"flagged":false,"tags":[],"title":"買い物"}]}"#
  )
}

@Test
func canonicalJSONUsesBrowserNumberFormatting() throws {
  let source = Data(#"{"confidence":0.95}"#.utf8)
  let value = try #require(
    try JSONSerialization.jsonObject(with: source) as? [String: Any]
  )

  #expect(try CanonicalJSON.string(value) == #"{"confidence":0.95}"#)
}

@Test
func canonicalJSONMatchesBrowserNumberBoundaries() throws {
  let value: [String: Any] = [
    "largeExponent": 1e21,
    "largePlain": 1e20,
    "negativeZero": -0.0,
    "smallDecimal": 1e-6,
    "smallExponent": 1e-7
  ]

  #expect(
    try CanonicalJSON.string(value) ==
      #"{"largeExponent":1e+21,"largePlain":100000000000000000000,"negativeZero":0,"smallDecimal":0.000001,"smallExponent":1e-7}"#
  )
}

@Test
func cryptoMatchesTheBrowserWebCryptoFixture() throws {
  let workspace: [String: Any] = [
    "schemaVersion": 3,
    "timeZone": "Asia/Tokyo",
    "todos": [Any]()
  ]
  let salt = Data((0..<16).map(UInt8.init))
  let nonce = Data((16..<28).map(UInt8.init))
  let payload = try SyncCrypto.encryptWorkspace(
    workspace,
    passphrase: "correct horse",
    salt: salt,
    nonce: nonce
  )

  #expect(payload.salt == "AAECAwQFBgcICQoLDA0ODw==")
  #expect(payload.iv == "EBESExQVFhcYGRob")
  #expect(
    payload.ciphertext ==
      "Fw1bMjNIj46c3iKdh/Bye88g9rlrrnxhTmQ3g2UC8jokoVbQYjX4h6rx6+pfDP5I1Z8MzpGVSwiwpryprpUfrH9tbo5caw=="
  )
  let decrypted = try SyncCrypto.decryptWorkspace(payload, passphrase: "correct horse")
  let decryptedString = try CanonicalJSON.string(decrypted)
  let workspaceString = try CanonicalJSON.string(workspace)
  #expect(decryptedString == workspaceString)
}
