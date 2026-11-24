import { describe, expect, it } from "vitest";
import { outOfRange, pageCount, pageWindow, readPaging, slicePage } from "./paging";

describe("reading the page from the address", () => {
  it("reads page and size, and falls back for anything odd", () => {
    expect(readPaging({ page: "3", size: "50" }, { defaultSize: 25 })).toEqual({ page: 3, pageSize: 50, offset: 100 });
    expect(readPaging({}, { defaultSize: 25 })).toEqual({ page: 1, pageSize: 25, offset: 0 });
    expect(readPaging({ page: "0", size: "7" }, { defaultSize: 25 })).toEqual({ page: 1, pageSize: 25, offset: 0 });
    expect(readPaging({ page: "-2", size: "100000" }, { defaultSize: 10 })).toEqual({ page: 1, pageSize: 10, offset: 0 });
    expect(readPaging({ page: "abc" }, { defaultSize: 25 }).page).toBe(1);
    expect(readPaging({ page: "2.5" }, { defaultSize: 25 }).page).toBe(1);
    expect(readPaging({ rpage: "2", rsize: "10" }, { defaultSize: 25, pageParam: "rpage", sizeParam: "rsize" })).toEqual({ page: 2, pageSize: 10, offset: 10 });
  });
});

describe("page numbers", () => {
  it("counts pages, at least one", () => {
    expect([pageCount(0, 25), pageCount(25, 25), pageCount(26, 25)]).toEqual([1, 1, 2]);
  });

  it("sends a page past the end to the last page", () => {
    expect(outOfRange(9, 60, 25)).toBe(3);
    expect(outOfRange(3, 60, 25)).toBeNull();
    expect(outOfRange(4, 0, 25)).toBeNull(); // nothing to show: the empty state
  });

  it("shows first, last and neighbours with gaps", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 5)).toEqual([1, 2, "gap", 5]);
    expect(pageWindow(5, 20)).toEqual([1, "gap", 4, 5, 6, "gap", 20]);
    expect(pageWindow(3, 20)).toEqual([1, 2, 3, 4, "gap", 20]);
    expect(pageWindow(20, 20)).toEqual([1, "gap", 19, 20]);
    expect(pageWindow(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("slices an in-memory list", () => {
    expect(slicePage([1, 2, 3, 4, 5], { page: 2, pageSize: 2, offset: 2 })).toEqual([3, 4]);
  });
});
