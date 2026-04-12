import { describe, it, expect } from "vitest"
import { posixPath } from "./posix-path"

describe("posixPath.normalize", () => {
    it("returns '.' for empty string", () => {
        expect(posixPath.normalize("")).toBe(".")
    })

    it("returns '/' for root", () => {
        expect(posixPath.normalize("/")).toBe("/")
    })

    it("removes trailing slashes", () => {
        expect(posixPath.normalize("/foo/bar/")).toBe("/foo/bar/")
    })

    it("resolves single dots", () => {
        expect(posixPath.normalize("/foo/./bar")).toBe("/foo/bar")
    })

    it("resolves double dots", () => {
        expect(posixPath.normalize("/foo/bar/../baz")).toBe("/foo/baz")
    })

    it("resolves multiple double dots", () => {
        expect(posixPath.normalize("/foo/bar/baz/../../qux")).toBe("/foo/qux")
    })

    it("handles double dots at the root", () => {
        // Implementation keeps .. when there's nothing to pop
        expect(posixPath.normalize("/..")).toBe("/..")
    })

    it("handles relative paths with double dots", () => {
        expect(posixPath.normalize("foo/bar/../baz")).toBe("foo/baz")
    })

    it("collapses multiple slashes", () => {
        expect(posixPath.normalize("/foo//bar///baz")).toBe("/foo/bar/baz")
    })

    it("handles just a dot", () => {
        expect(posixPath.normalize(".")).toBe(".")
    })

    it("handles relative path normalization", () => {
        expect(posixPath.normalize("foo/bar")).toBe("foo/bar")
    })
})

describe("posixPath.join", () => {
    it("joins two segments", () => {
        expect(posixPath.join("foo", "bar")).toBe("foo/bar")
    })

    it("joins absolute path with relative", () => {
        expect(posixPath.join("/foo", "bar")).toBe("/foo/bar")
    })

    it("resolves dots in joined path", () => {
        expect(posixPath.join("/foo", "./bar", "../baz")).toBe("/foo/baz")
    })

    it("ignores empty strings", () => {
        expect(posixPath.join("foo", "", "bar")).toBe("foo/bar")
    })

    it("handles single segment", () => {
        expect(posixPath.join("foo")).toBe("foo")
    })

    it("joins multiple segments", () => {
        expect(posixPath.join("a", "b", "c", "d")).toBe("a/b/c/d")
    })
})

describe("posixPath.resolve", () => {
    it("resolves absolute path", () => {
        expect(posixPath.resolve("/foo/bar")).toBe("/foo/bar")
    })

    it("resolves relative against absolute", () => {
        expect(posixPath.resolve("/foo", "bar")).toBe("/foo/bar")
    })

    it("later absolute path wins", () => {
        expect(posixPath.resolve("/foo", "/bar")).toBe("/bar")
    })

    it("resolves dots", () => {
        expect(posixPath.resolve("/foo", "bar", "..", "baz")).toBe("/foo/baz")
    })

    it("defaults to / when no arguments", () => {
        expect(posixPath.resolve("")).toBe("/")
    })
})

describe("posixPath.dirname", () => {
    it("returns directory of file path", () => {
        expect(posixPath.dirname("/foo/bar/baz.txt")).toBe("/foo/bar")
    })

    it("returns / for root-level file", () => {
        expect(posixPath.dirname("/foo")).toBe("/")
    })

    it("returns / for root", () => {
        expect(posixPath.dirname("/")).toBe("/")
    })

    it("returns . for empty string", () => {
        expect(posixPath.dirname("")).toBe(".")
    })

    it("returns . for plain filename", () => {
        expect(posixPath.dirname("foo")).toBe(".")
    })

    it("returns parent for nested relative", () => {
        expect(posixPath.dirname("foo/bar")).toBe("foo")
    })
})

describe("posixPath.basename", () => {
    it("returns filename", () => {
        expect(posixPath.basename("/foo/bar/baz.txt")).toBe("baz.txt")
    })

    it("strips extension when provided", () => {
        expect(posixPath.basename("/foo/bar/baz.txt", ".txt")).toBe("baz")
    })

    it("returns full name when extension does not match", () => {
        expect(posixPath.basename("/foo/bar/baz.txt", ".js")).toBe("baz.txt")
    })

    it("returns last segment for directory path", () => {
        expect(posixPath.basename("/foo/bar")).toBe("bar")
    })

    it("handles root path", () => {
        expect(posixPath.basename("/")).toBe("")
    })

    it("handles filename without dir", () => {
        expect(posixPath.basename("file.js")).toBe("file.js")
    })
})

describe("posixPath.relative", () => {
    it("returns relative path between siblings", () => {
        expect(posixPath.relative("/foo/bar", "/foo/baz")).toBe("../baz")
    })

    it("returns empty for same path", () => {
        expect(posixPath.relative("/foo/bar", "/foo/bar")).toBe("")
    })

    it("returns child path", () => {
        expect(posixPath.relative("/foo", "/foo/bar/baz")).toBe("bar/baz")
    })

    it("returns parent path", () => {
        expect(posixPath.relative("/foo/bar/baz", "/foo")).toBe("../..")
    })

    it("handles completely different trees", () => {
        expect(posixPath.relative("/a/b/c", "/x/y/z")).toBe("../../../x/y/z")
    })
})

describe("posixPath.isAbsolute", () => {
    it("returns true for absolute paths", () => {
        expect(posixPath.isAbsolute("/foo")).toBe(true)
        expect(posixPath.isAbsolute("/")).toBe(true)
    })

    it("returns false for relative paths", () => {
        expect(posixPath.isAbsolute("foo")).toBe(false)
        expect(posixPath.isAbsolute("./foo")).toBe(false)
        expect(posixPath.isAbsolute("")).toBe(false)
    })
})
