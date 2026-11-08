// Makes every request the client makes once: points it at the recording server, as the app configures it (the users
// client with its server's URL, the orders router with API_SERVER_URL, which the oracle's command sets), and calls each
// public method with ARG for a String argument and ARG_NUMBER for an Int.
import Client
import Foundation

let environment = ProcessInfo.processInfo.environment
let arg = environment["ARG"]!
let number = Int(environment["ARG_NUMBER"]!)!

let users = UsersClient(server: environment["RECORD_URL"]!)
_ = try await users.users(page: number)
_ = try await users.user(id: arg)
_ = try await users.createUser(name: arg)
_ = try await users.replaceUser(id: arg, name: arg)
_ = try await users.renameUser(id: arg, name: arg)
_ = try await users.deleteUser(id: arg)
_ = try await users.avatar(id: arg)

let orders = OrdersAPI(token: arg)
_ = try await orders.orders(status: arg)
_ = try await orders.order(number: number)
_ = try await orders.addNote(number: number, text: arg)
_ = try await orders.cancel(number: number)

// The version SwiftPM resolved and built: Alamofire reports none at run time.
let resolved = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "Package.resolved"))) as! [String: Any]
let pins = resolved["pins"] as! [[String: Any]]
let alamofire = pins.first { ($0["identity"] as? String) == "alamofire" }!
let version = (alamofire["state"] as! [String: Any])["version"] as! String
let out = ["library": "Alamofire", "version": version]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
