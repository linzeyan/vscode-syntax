import Foundation

struct User: Codable {
    let id: Int
    var name: String
}

func greet(_ user: User) -> String {
    guard user.id > 0 else { return "unknown" }
    return "Hello, \(user.name)!"
}
