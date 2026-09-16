import CommonCrypto
import CryptoKit
import Foundation
import Security

public enum SyncCrypto {
  public static let kdfIterations = 210_000

  public static func encryptWorkspace(
    _ workspace: [String: Any],
    passphrase: String,
    salt suppliedSalt: Data? = nil,
    nonce suppliedNonce: Data? = nil
  ) throws -> EncryptedSyncPayload {
    let salt = try suppliedSalt ?? randomData(count: 16)
    let nonceData = try suppliedNonce ?? randomData(count: 12)
    let key = try deriveKey(passphrase: passphrase, salt: salt, iterations: kdfIterations)
    let nonce = try AES.GCM.Nonce(data: nonceData)
    let plaintext = try CanonicalJSON.data(workspace)
    let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
    var ciphertext = sealed.ciphertext
    ciphertext.append(sealed.tag)
    return EncryptedSyncPayload(
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: kdfIterations,
      salt: salt.base64EncodedString(),
      iv: nonceData.base64EncodedString(),
      ciphertext: ciphertext.base64EncodedString()
    )
  }

  public static func decryptWorkspace(
    _ payload: EncryptedSyncPayload,
    passphrase: String
  ) throws -> [String: Any] {
    guard payload.algorithm == "AES-GCM", payload.kdf == "PBKDF2-SHA256" else {
      throw CompanionError.invalidRemoteData("Unsupported encryption algorithm.")
    }
    guard (1...1_000_000).contains(payload.iterations),
          let salt = Data(base64Encoded: payload.salt),
          let nonceData = Data(base64Encoded: payload.iv),
          let encrypted = Data(base64Encoded: payload.ciphertext),
          encrypted.count >= 16
    else {
      throw CompanionError.invalidRemoteData("Encrypted payload fields are invalid.")
    }
    let key = try deriveKey(passphrase: passphrase, salt: salt, iterations: payload.iterations)
    let ciphertext = encrypted.dropLast(16)
    let tag = encrypted.suffix(16)
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceData),
        ciphertext: ciphertext,
        tag: tag
      )
      let plaintext = try AES.GCM.open(box, using: key)
      guard let workspace = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else {
        throw CompanionError.invalidRemoteData("Decrypted workspace is not an object.")
      }
      return workspace
    } catch let error as CompanionError {
      throw error
    } catch {
      throw CompanionError.decryptionFailed
    }
  }

  public static func sealLocalData(_ plaintext: Data, keyData: Data) throws -> Data {
    guard keyData.count == 32 else {
      throw CompanionError.encryptionFailed
    }
    do {
      let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: keyData))
      guard let combined = box.combined else {
        throw CompanionError.encryptionFailed
      }
      return combined
    } catch let error as CompanionError {
      throw error
    } catch {
      throw CompanionError.encryptionFailed
    }
  }

  public static func openLocalData(_ combined: Data, keyData: Data) throws -> Data {
    guard keyData.count == 32 else {
      throw CompanionError.decryptionFailed
    }
    do {
      return try AES.GCM.open(
        AES.GCM.SealedBox(combined: combined),
        using: SymmetricKey(data: keyData)
      )
    } catch {
      throw CompanionError.decryptionFailed
    }
  }

  public static func randomData(count: Int) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
      throw CompanionError.encryptionFailed
    }
    return Data(bytes)
  }

  private static func deriveKey(
    passphrase: String,
    salt: Data,
    iterations: Int
  ) throws -> SymmetricKey {
    var output = [UInt8](repeating: 0, count: 32)
    let status = passphrase.utf8CString.withUnsafeBufferPointer { password in
      salt.withUnsafeBytes { saltBuffer in
        CCKeyDerivationPBKDF(
          CCPBKDFAlgorithm(kCCPBKDF2),
          password.baseAddress,
          max(0, password.count - 1),
          saltBuffer.bindMemory(to: UInt8.self).baseAddress,
          salt.count,
          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
          UInt32(iterations),
          &output,
          output.count
        )
      }
    }
    guard status == kCCSuccess else {
      throw CompanionError.encryptionFailed
    }
    return SymmetricKey(data: Data(output))
  }
}
