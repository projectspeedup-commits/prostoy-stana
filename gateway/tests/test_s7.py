import struct
import unittest

from support import config
from stan_gateway.config import S7Config, Tag
from stan_gateway.sources.s7 import Address, S7Source, decode, parse_address, plan_reads


class AddressTests(unittest.TestCase):
    def test_wincc_addresses(self):
        expected = {
            "M500.6": Address("MK", 0, 500, 1, 6),
            "DB404,DBW124": Address("DB", 404, 124, 2),
            "DB1012,DBX10.3": Address("DB", 1012, 10, 1, 3),
            "I85.1": Address("PE", 0, 85, 1, 1),
            "Q1046.4": Address("PA", 0, 1046, 1, 4),
            "DB9,DBD20": Address("DB", 9, 20, 4),
        }
        for text, address in expected.items():
            with self.subTest(address=text):
                self.assertEqual(parse_address(text), address)

    def test_invalid_addresses_and_types(self):
        for address in ("M500.8", "DB404.DBW124", "DB1,DBX10", "DB1,DBW10.1", "Z1.0", "M-1.0", "DB0,DBW0", "M2097152.0"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                parse_address(address)
        for address, kind in (("M500.6", "int"), ("DB1,DBW10", "bool"), ("DB1,DBW10", "real")):
            with self.subTest(address=address), self.assertRaises(ValueError):
                parse_address(address, kind)

    def test_decode_big_endian_int_real_and_bits(self):
        self.assertTrue(decode(b"\x40", parse_address("M500.6"), "bool"))
        self.assertEqual(decode(b"\xff\xfe", parse_address("DB1,DBW0"), "int"), -2)
        self.assertEqual(decode(struct.pack(">i", -123456), parse_address("DB1,DBD0"), "int"), -123456)
        self.assertAlmostEqual(decode(struct.pack(">f", 1.25), parse_address("DB1,DBD0"), "real"), 1.25)

    def test_group_bits_and_words_per_area(self):
        tags = (Tag("a", "bool", "M500.6"), Tag("b", "bool", "M500.7"), Tag("c", "bool", "M501.0"),
                Tag("d", "int", "DB404,DBW124"), Tag("e", "int", "DB404,DBW126"))
        blocks = plan_reads(tags)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(sorted(block.end - block.start for block in blocks), [2, 4])

    def test_large_gaps_and_different_dbs_are_separate(self):
        tags = (Tag("a", "bool", "M0.0"), Tag("b", "bool", "M500.0"),
                Tag("c", "int", "DB1,DBW0"), Tag("d", "int", "DB2,DBW0"))
        self.assertEqual(len(plan_reads(tags)), 4)

    def test_source_reads_block_once_not_each_bit(self):
        class FakeClient:
            calls = []

            def read_area(self, area, db, start, size):
                self.calls.append((area, db, start, size))
                return bytearray([0b11000000, 1])

        source = S7Source(S7Config(), (Tag("a", "bool", "M500.6"), Tag("b", "bool", "M500.7"), Tag("c", "bool", "M501.0")))
        source.client = FakeClient()
        values = source._read()
        self.assertTrue(all(reading.value for reading in values.values()))
        self.assertEqual(len(source.client.calls), 1)
        self.assertEqual(source.client.calls[0][2:], (500, 2))

    def test_bundled_snap7_dll_loads_without_connection(self):
        from snap7.client import Client
        client = Client()
        try:
            self.assertFalse(client.get_connected())
        finally:
            client.destroy()
