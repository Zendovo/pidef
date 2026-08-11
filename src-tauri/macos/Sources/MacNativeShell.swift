import AppKit
import ObjectiveC
import SwiftUI
import WebKit

@_cdecl("install_mac_native_shell")
public func installMacNativeShell(_ rawWindow: UnsafeMutableRawPointer?) {
  guard let rawWindow else { return }

  DispatchQueue.main.async {
    let window = unsafeBitCast(rawWindow, to: NSWindow.self)
    MacNativeShellInstaller.install(on: window)
  }
}

@_cdecl("set_mac_native_sidebar_collapsed")
public func setMacNativeSidebarCollapsed(_ rawWindow: UnsafeMutableRawPointer?, _ collapsedValue: Int32) {
  guard let rawWindow else { return }
  let isCollapsed = collapsedValue != 0

  DispatchQueue.main.async {
    let window = unsafeBitCast(rawWindow, to: NSWindow.self)
    MacNativeShellRegistry.sidebarState(for: window)?.setCollapsed(isCollapsed)
  }
}

private enum MacNativeShellRegistry {
  private static var sidebarStateKey: UInt8 = 0

  static func setSidebarState(_ state: MacSidebarState, for window: NSWindow) {
    objc_setAssociatedObject(window, &sidebarStateKey, state, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
  }

  static func sidebarState(for window: NSWindow) -> MacSidebarState? {
    objc_getAssociatedObject(window, &sidebarStateKey) as? MacSidebarState
  }
}

private enum MacNativeShellInstaller {
  private static let sidebarIdentifier = NSUserInterfaceItemIdentifier("PidefMacNativeSidebar")
  private static let toggleIdentifier = NSUserInterfaceItemIdentifier("PidefMacNativeSidebarToggle")
  private static let sidebarWidth: CGFloat = 260
  private static let collapsedToggleLeading: CGFloat = 28
  private static let collapsedToggleTop: CGFloat = 54

  static func install(on window: NSWindow) {
    guard let contentView = window.contentView else { return }
    guard findView(with: sidebarIdentifier, in: contentView) == nil else { return }

    configureWindow(window)

    let webView = findWebView(in: contentView)
    prepareWebViewForNativeChrome(webView)
    markNativeShellReady(in: webView)

    let sidebarState = MacSidebarState(isCollapsed: true)
    MacNativeShellRegistry.setSidebarState(sidebarState, for: window)
    let sidebarContent = NSHostingView(
      rootView: MacNativeSidebar(sidebarState: sidebarState) { toolID in
        selectTool(toolID, in: webView)
      }
    )
    sidebarContent.translatesAutoresizingMaskIntoConstraints = false
    sidebarContent.wantsLayer = true
    sidebarContent.layer?.backgroundColor = NSColor.clear.cgColor

    let sidebar = makeSidebarContainer(contentView: sidebarContent)
    sidebar.identifier = sidebarIdentifier
    sidebar.translatesAutoresizingMaskIntoConstraints = false

    let floatingToggle = NSHostingView(
      rootView: MacSidebarFloatingControls(sidebarState: sidebarState) {
        selectTool(MacTool.home.id, in: webView)
      }
    )
    floatingToggle.identifier = toggleIdentifier
    floatingToggle.translatesAutoresizingMaskIntoConstraints = false
    floatingToggle.wantsLayer = true
    floatingToggle.layer?.backgroundColor = NSColor.clear.cgColor
    floatingToggle.alphaValue = 0

    contentView.addSubview(sidebar, positioned: .above, relativeTo: nil)
    contentView.addSubview(floatingToggle, positioned: .above, relativeTo: sidebar)
    let sidebarWidthConstraint = sidebar.widthAnchor.constraint(equalToConstant: 0)
    sidebar.alphaValue = 0
    sidebar.isHidden = true
    floatingToggle.alphaValue = 1
    NSLayoutConstraint.activate([
      sidebar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      sidebar.topAnchor.constraint(equalTo: contentView.topAnchor),
      sidebar.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      sidebarWidthConstraint,
      floatingToggle.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: collapsedToggleLeading),
      floatingToggle.topAnchor.constraint(equalTo: contentView.topAnchor, constant: collapsedToggleTop),
      floatingToggle.widthAnchor.constraint(equalToConstant: 66),
      floatingToggle.heightAnchor.constraint(equalToConstant: 30),
    ])

    sidebarState.onCollapsedChange = { [weak sidebar, weak floatingToggle, weak webView] isCollapsed in
      if !isCollapsed {
        sidebar?.isHidden = false
      }

      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.18
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        sidebarWidthConstraint.animator().constant = isCollapsed ? 0 : sidebarWidth
        sidebar?.animator().alphaValue = isCollapsed ? 0 : 1
        floatingToggle?.animator().alphaValue = isCollapsed ? 1 : 0
        contentView.layoutSubtreeIfNeeded()
      } completionHandler: {
        sidebar?.isHidden = isCollapsed
      }

      setNativeSidebarCollapsed(isCollapsed, in: webView)
    }
    setNativeSidebarCollapsed(true, in: webView)
  }

  private static func configureWindow(_ window: NSWindow) {
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = false
    window.isOpaque = false
    window.backgroundColor = .clear
    window.tabbingMode = .disallowed
    window.styleMask.insert(.fullSizeContentView)

    window.contentView?.wantsLayer = true
    window.contentView?.layer?.backgroundColor = NSColor.clear.cgColor

    if #available(macOS 11.0, *) {
      window.toolbarStyle = .unifiedCompact
    }
  }

  private static func makeSidebarContainer(contentView: NSView) -> NSView {
    if #available(macOS 26.0, *) {
      let glassView = NSGlassEffectView()
      glassView.style = .regular
      glassView.cornerRadius = 0
      glassView.tintColor = NSColor.white.withAlphaComponent(0.01)
      glassView.contentView = contentView
      return glassView
    }

    let visualEffectView = NSVisualEffectView()
    visualEffectView.material = .sidebar
    visualEffectView.blendingMode = .behindWindow
    visualEffectView.state = .active
    visualEffectView.addSubview(contentView)
    NSLayoutConstraint.activate([
      contentView.leadingAnchor.constraint(equalTo: visualEffectView.leadingAnchor),
      contentView.trailingAnchor.constraint(equalTo: visualEffectView.trailingAnchor),
      contentView.topAnchor.constraint(equalTo: visualEffectView.topAnchor),
      contentView.bottomAnchor.constraint(equalTo: visualEffectView.bottomAnchor),
    ])
    return visualEffectView
  }

  private static func prepareWebViewForNativeChrome(_ webView: WKWebView?) {
    guard let webView else { return }

    webView.setValue(false, forKey: "drawsBackground")
    webView.layer?.backgroundColor = NSColor.clear.cgColor
    webView.enclosingScrollView?.drawsBackground = false
  }

  private static func markNativeShellReady(in webView: WKWebView?) {
    guard let webView else { return }

    let script = """
      document.body.dataset.nativeShell = 'macos';
      window.dispatchEvent(new CustomEvent('native-shell-ready', { detail: { platform: 'macos' } }));
    """
    let userScript = WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
    webView.configuration.userContentController.addUserScript(userScript)
    webView.evaluateJavaScript(script)
  }

  private static func selectTool(_ toolID: String, in webView: WKWebView?) {
    let escapedToolID = toolID
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "'", with: "\\'")

    let script = """
      window.dispatchEvent(new CustomEvent('native-tool-selected', { detail: { tool: '\(escapedToolID)' } }));
    """
    webView?.evaluateJavaScript(script)
  }

  private static func setNativeSidebarCollapsed(_ isCollapsed: Bool, in webView: WKWebView?) {
    let script = """
      document.body.dataset.nativeSidebar = '\(isCollapsed ? "collapsed" : "expanded")';
      window.dispatchEvent(new CustomEvent('native-sidebar-visibility', { detail: { collapsed: \(isCollapsed ? "true" : "false") } }));
    """
    webView?.evaluateJavaScript(script)
  }

  private static func findWebView(in view: NSView) -> WKWebView? {
    if let webView = view as? WKWebView {
      return webView
    }

    for subview in view.subviews {
      if let webView = findWebView(in: subview) {
        return webView
      }
    }

    return nil
  }

  private static func findView(with identifier: NSUserInterfaceItemIdentifier, in view: NSView) -> NSView? {
    if view.identifier == identifier {
      return view
    }

    for subview in view.subviews {
      if let match = findView(with: identifier, in: subview) {
        return match
      }
    }

    return nil
  }
}

private final class MacSidebarState: ObservableObject {
  @Published var isCollapsed: Bool
  var onCollapsedChange: ((Bool) -> Void)?

  init(isCollapsed: Bool = false) {
    self.isCollapsed = isCollapsed
  }

  func setCollapsed(_ collapsed: Bool) {
    guard isCollapsed != collapsed else { return }
    isCollapsed = collapsed
    onCollapsedChange?(isCollapsed)
  }

  func toggle() {
    setCollapsed(!isCollapsed)
  }
}

private struct MacNativeSidebar: View {
  @State private var selectedToolID = MacTool.home.id
  @State private var hoveredToolID: String?
  @ObservedObject var sidebarState: MacSidebarState
  let onSelect: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        brand
        WindowDragRegion()
          .frame(maxWidth: .infinity, minHeight: 30, maxHeight: 30)
        Spacer(minLength: 12)
        MacSidebarToggleButton(sidebarState: sidebarState)
      }
        .padding(.top, 18)
        .padding(.horizontal, 18)
        .padding(.bottom, 18)

      ScrollView(.vertical, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 5) {
          toolButton(.home)

          Text("TOOLS")
            .font(MacSidebarFont.section)
            .foregroundStyle(Color.secondary.opacity(0.54))
            .padding(.horizontal, 8)
            .padding(.top, 12)
            .padding(.bottom, 3)

          ForEach(MacTool.all) { tool in
            toolButton(tool)
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 18)
      }

      Spacer(minLength: 12)

      WindowDragRegion()
        .frame(height: 24)
        .padding(.horizontal, 16)

      toolButton(.history)
        .padding(.horizontal, 16)

      toolButton(.settings)
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(Color.clear)
    .overlay(alignment: .trailing) {
      Rectangle()
        .fill(.separator.opacity(0.5))
        .frame(width: 1)
    }
  }

  private var brand: some View {
    Text("Pidef")
      .font(MacSidebarFont.brand)
      .foregroundStyle(Color.primary.opacity(0.76))
      .overlay(WindowDragRegion())
  }

  private func toolButton(_ tool: MacTool) -> some View {
    Button {
      selectedToolID = tool.id
      onSelect(tool.id)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: tool.symbol)
          .font(MacSidebarFont.icon)
          .foregroundStyle(Color.secondary.opacity(0.64))
          .frame(width: 20, height: 20)

        VStack(alignment: .leading, spacing: 1) {
          Text(tool.title)
            .font(MacSidebarFont.item)
            .foregroundStyle(Color.primary.opacity(0.74))
        }

        Spacer(minLength: 8)
      }
      .contentShape(Rectangle())
      .padding(.horizontal, 8)
      .frame(height: 30)
      .nativeSelectionSurface(isSelected: selectedToolID == tool.id, isHovered: hoveredToolID == tool.id)
    }
    .buttonStyle(.plain)
    .onHover { isHovered in
      hoveredToolID = isHovered ? tool.id : nil
    }
  }
}

private struct WindowDragRegion: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    SidebarDragView()
  }

  func updateNSView(_ nsView: NSView, context: Context) {}
}

private final class SidebarDragView: NSView {
  override var mouseDownCanMoveWindow: Bool {
    true
  }

  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }
}

private struct MacSidebarFloatingControls: View {
  @ObservedObject var sidebarState: MacSidebarState
  let onHome: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      MacSidebarToggleButton(sidebarState: sidebarState)
      if sidebarState.isCollapsed {
        MacSidebarHomeButton(onHome: onHome)
      }
    }
  }
}

private struct MacSidebarHomeButton: View {
  let onHome: () -> Void
  @State private var isHovered = false

  var body: some View {
    Button {
      onHome()
    } label: {
      Image(systemName: "house")
        .font(.system(size: 14, weight: .regular, design: .default))
        .foregroundStyle(Color.secondary.opacity(0.78))
        .frame(width: 30, height: 30)
        .contentShape(Rectangle())
        .nativeSelectionSurface(isSelected: false, isHovered: isHovered)
    }
    .buttonStyle(.plain)
    .help("Home")
    .onHover { isHovered = $0 }
  }
}

private struct MacSidebarToggleButton: View {
  @ObservedObject var sidebarState: MacSidebarState
  @State private var isHovered = false

  var body: some View {
    Button {
      sidebarState.toggle()
    } label: {
      Image(systemName: "sidebar.left")
        .font(.system(size: 15, weight: .regular, design: .default))
        .foregroundStyle(Color.secondary.opacity(0.78))
        .frame(width: 30, height: 30)
        .contentShape(Rectangle())
        .nativeSelectionSurface(isSelected: false, isHovered: isHovered)
    }
    .buttonStyle(.plain)
    .help(sidebarState.isCollapsed ? "Show Sidebar" : "Hide Sidebar")
    .onHover { isHovered = $0 }
  }
}

private enum MacSidebarFont {
  static let brand: Font = .system(size: 19, weight: .semibold, design: .default)
  static let item: Font = .system(size: 14, weight: .regular, design: .default)
  static let section: Font = .system(size: 11, weight: .semibold, design: .default)
  static let icon: Font = .system(size: 14, weight: .regular, design: .default)
}

private struct MacTool: Identifiable {
  let id: String
  let title: String
  let symbol: String

  static let home = MacTool(id: "home", title: "Home", symbol: "house")

  static let all: [MacTool] = [
    .init(id: "mergePdf", title: "Merge PDF", symbol: "doc.on.doc"),
    .init(id: "splitPdf", title: "Split PDF", symbol: "scissors"),
    .init(id: "organizePdf", title: "Organize PDF", symbol: "square.stack.3d.up"),
    .init(id: "compressPdf", title: "Compress PDF", symbol: "archivebox"),
    .init(id: "pdfToJpg", title: "PDF to JPG", symbol: "photo"),
    .init(id: "jpgToPdf", title: "JPG to PDF", symbol: "photo.stack"),
    .init(id: "pptToPdf", title: "PPT to PDF", symbol: "rectangle.on.rectangle"),
    .init(id: "wordToPdf", title: "Word to PDF", symbol: "doc.text"),
    .init(id: "unlockPdf", title: "Unlock PDF", symbol: "lock.open"),
    .init(id: "protectPdf", title: "Protect PDF", symbol: "lock.shield"),
  ]

  static let settings = MacTool(id: "settings", title: "Settings", symbol: "gearshape")
  static let history = MacTool(id: "history", title: "History", symbol: "clock")
}

private extension View {
  @ViewBuilder
  func nativeGlassSurface(cornerRadius: CGFloat) -> some View {
    if #available(macOS 26.0, *) {
      self.glassEffect(.regular.interactive(), in: .rect(cornerRadius: cornerRadius))
    } else {
      self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
    }
  }

  @ViewBuilder
  func nativeSelectionSurface(isSelected: Bool, isHovered: Bool) -> some View {
    if #available(macOS 26.0, *) {
      if isSelected || isHovered {
        self.glassEffect(
          .regular.tint(.white.opacity(isSelected ? 0.08 : 0.045)).interactive(),
          in: .rect(cornerRadius: 6)
        )
      } else {
        self.background(.clear, in: RoundedRectangle(cornerRadius: 6))
      }
    } else if isSelected || isHovered {
      self.background(.selection.opacity(isSelected ? 0.1 : 0.065), in: RoundedRectangle(cornerRadius: 6))
    } else {
      self.background(.clear, in: RoundedRectangle(cornerRadius: 6))
    }
  }
}
