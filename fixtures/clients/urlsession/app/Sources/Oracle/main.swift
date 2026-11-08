// Makes every request the client makes once: points it at the recording server, as the app configures it with its
// server's URL, and calls each public method with ARG for a String argument and ARG_NUMBER for an Int.
import Client
import Foundation

let environment = ProcessInfo.processInfo.environment
let server = URL(string: environment["RECORD_URL"]!)!
let arg = environment["ARG"]!
let number = Int(environment["ARG_NUMBER"]!)!

let users = UsersAPI(server: server)
_ = try await users.user(id: arg)
_ = try await users.createUser(name: arg)
try await users.replaceUser(id: arg, name: arg)
try await users.renameUser(id: arg, name: arg)
try await users.deleteUser(id: arg)
_ = try await users.avatar(id: arg)

let store = StoreAPI(server: server)
_ = try await store.search(term: arg, page: number)
_ = try await store.order(number: number)
try await store.cancelOrder(number: number)

// Foundation reports no version of its own: it is the toolchain's, which the oracle's command passes in.
let out = ["library": "URLSession (Foundation)", "version": environment["SWIFT_VERSION"] ?? "unknown"]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
