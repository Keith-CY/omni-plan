import CryptoKit
import Foundation

public enum CanonicalJSON {
  public static func data(_ object: Any) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw CompanionError.invalidRemoteData("Workspace is not valid JSON.")
    }
    let foundationData = try JSONSerialization.data(
      withJSONObject: object,
      options: [.withoutEscapingSlashes]
    )
    let value = try JSONDecoder().decode(CanonicalJSONValue.self, from: foundationData)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try normalizeBrowserNumbers(in: encoder.encode(value))
  }

  public static func string(_ object: Any) throws -> String {
    guard let value = String(data: try data(object), encoding: .utf8) else {
      throw CompanionError.invalidRemoteData("Workspace JSON is not UTF-8.")
    }
    return value
  }

  public static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  public static func sha256Hex(_ value: String) -> String {
    sha256Hex(Data(value.utf8))
  }

  private static func normalizeBrowserNumbers(in data: Data) throws -> Data {
    let bytes = [UInt8](data)
    var output = Data()
    output.reserveCapacity(data.count)
    var index = 0
    var isInsideString = false
    var isEscaped = false

    while index < bytes.count {
      let byte = bytes[index]
      if isInsideString {
        output.append(byte)
        if isEscaped {
          isEscaped = false
        } else if byte == CharacterByte.backslash {
          isEscaped = true
        } else if byte == CharacterByte.quote {
          isInsideString = false
        }
        index += 1
        continue
      }

      if byte == CharacterByte.quote {
        isInsideString = true
        output.append(byte)
        index += 1
        continue
      }

      if byte == CharacterByte.minus || CharacterByte.isDigit(byte) {
        let start = index
        index += 1
        while index < bytes.count, CharacterByte.isNumberPart(bytes[index]) {
          index += 1
        }
        guard let token = String(bytes: bytes[start..<index], encoding: .utf8),
              let number = Double(token)
        else {
          throw CompanionError.invalidRemoteData("Workspace contains an invalid JSON number.")
        }
        output.append(contentsOf: javaScriptNumberString(number).utf8)
        continue
      }

      output.append(byte)
      index += 1
    }

    return output
  }

  private static func javaScriptNumberString(_ value: Double) -> String {
    if value == 0 {
      return "0"
    }

    var shortest = String(value).lowercased()
    if shortest.hasSuffix(".0") {
      shortest.removeLast(2)
    }
    guard let exponentIndex = shortest.firstIndex(of: "e") else {
      return shortest
    }

    let magnitude = abs(value)
    if magnitude >= 0.000001, magnitude < 1e21 {
      return expandExponent(shortest, exponentIndex: exponentIndex)
    }

    let mantissa = String(shortest[..<exponentIndex])
    let exponentText = shortest[shortest.index(after: exponentIndex)...]
    let exponent = Int(exponentText) ?? 0
    return "\(mantissa)e\(exponent >= 0 ? "+" : "")\(exponent)"
  }

  private static func expandExponent(
    _ value: String,
    exponentIndex: String.Index
  ) -> String {
    var mantissa = String(value[..<exponentIndex])
    let exponentText = value[value.index(after: exponentIndex)...]
    let exponent = Int(exponentText) ?? 0
    let isNegative = mantissa.removeFirstIfPresent("-")
    let dotIndex = mantissa.firstIndex(of: ".")
    let integerDigitCount = dotIndex.map { mantissa.distance(from: mantissa.startIndex, to: $0) }
      ?? mantissa.count
    let digits = mantissa.filter { $0 != "." }
    let decimalIndex = integerDigitCount + exponent

    let expanded: String
    if decimalIndex <= 0 {
      expanded = "0." + String(repeating: "0", count: -decimalIndex) + digits
    } else if decimalIndex >= digits.count {
      expanded = digits + String(repeating: "0", count: decimalIndex - digits.count)
    } else {
      let split = digits.index(digits.startIndex, offsetBy: decimalIndex)
      expanded = String(digits[..<split]) + "." + String(digits[split...])
    }
    return isNegative ? "-\(expanded)" : expanded
  }
}

private enum CanonicalJSONValue: Codable {
  case null
  case boolean(Bool)
  case number(Double)
  case string(String)
  case array([CanonicalJSONValue])
  case object([String: CanonicalJSONValue])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .boolean(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([CanonicalJSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode([String: CanonicalJSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Unsupported JSON value."
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null:
      try container.encodeNil()
    case let .boolean(value):
      try container.encode(value)
    case let .number(value):
      try container.encode(value)
    case let .string(value):
      try container.encode(value)
    case let .array(value):
      try container.encode(value)
    case let .object(value):
      try container.encode(value)
    }
  }
}

private enum CharacterByte {
  static let quote = UInt8(ascii: "\"")
  static let backslash = UInt8(ascii: "\\")
  static let minus = UInt8(ascii: "-")

  static func isDigit(_ byte: UInt8) -> Bool {
    byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")
  }

  static func isNumberPart(_ byte: UInt8) -> Bool {
    isDigit(byte) ||
      byte == UInt8(ascii: ".") ||
      byte == UInt8(ascii: "e") ||
      byte == UInt8(ascii: "E") ||
      byte == UInt8(ascii: "+") ||
      byte == minus
  }
}

private extension String {
  mutating func removeFirstIfPresent(_ prefix: Character) -> Bool {
    guard first == prefix else {
      return false
    }
    removeFirst()
    return true
  }
}
